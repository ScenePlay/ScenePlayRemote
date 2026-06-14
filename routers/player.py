import asyncio
import json
import os
import re
import sqlite3
from datetime import datetime, timezone

import bcrypt as _bcrypt
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import db
from auth import issue_player_token, verify_player_token
from broadcast import publish, mark_present
from models import (CharacterRequest, JoinRequest, JoinResponse, RollRequest,
                    HpDeltaRequest, ChangePasswordRequest, MutationRequest,
                    PortraitUploadRequest)

_PORTRAITS_DIR = os.path.join(os.path.dirname(__file__), '..', 'portal', 'portraits')

_SCENPLAY_DB = os.path.join(os.path.dirname(__file__), '..', '..', 'ScenePlay', 'ScenePlay.db')


def _write_to_sp_db(player_name: str, roll_expr: str, result: int, breakdown: str) -> None:
    """Write a relay player roll into ScenePlay's tblDiceRolls.
    Uses character_id=-1 as a relay marker so the SSE poller won't re-broadcast it."""
    if not os.path.exists(_SCENPLAY_DB):
        return
    # Parse individual dice values from breakdown ("5, 12, 3+4" → [5,12,3], mod=4)
    mod_match = re.search(r'([+-]\d+)$', breakdown)
    mod = int(mod_match.group(1)) if mod_match else 0
    dice_str = re.split(r'[+-]\d+$', breakdown)[0].strip()
    dice = []
    for part in dice_str.split(','):
        part = part.strip()
        if part.lstrip('-').isdigit():
            dice.append(int(part))
    if not dice:
        kept = result - mod
        dice = [kept] if kept > 0 else [result]
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    try:
        conn = sqlite3.connect(_SCENPLAY_DB, timeout=5.0)
        conn.execute(
            """INSERT INTO tblDiceRolls
               (character_id, char_name, expression, label, dice_json, modifier, total, adv_mode, rolled_at)
               VALUES (-1, ?, ?, '', ?, ?, ?, 'normal', ?)""",
            (player_name, roll_expr, json.dumps(dice), mod, result, now),
        )
        conn.commit()
        # Keep most recent 50 rows
        conn.execute(
            """DELETE FROM tblDiceRolls WHERE roll_id NOT IN
               (SELECT roll_id FROM tblDiceRolls ORDER BY roll_id DESC LIMIT 50)"""
        )
        conn.commit()
        conn.close()
    except Exception:
        pass

router = APIRouter()
_bearer = HTTPBearer()


def _verify_password(plain: str, hashed: str) -> bool:
    try:
        return _bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def _get_player(credentials: HTTPAuthorizationCredentials = Depends(_bearer)) -> dict:
    try:
        return verify_player_token(credentials.credentials)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc))


@router.post("/join", response_model=JoinResponse)
async def join(request: JoinRequest):
    # 1. Resolve session by join code
    session = await db.get_session_by_code(request.code.upper().strip())
    if not session:
        raise HTTPException(status_code=404, detail="Invalid join code")

    # 2. Find character record by username (relay-local lookup)
    username = request.name.strip()
    existing = await db.get_character_by_username(session["id"], username)
    if not existing:
        raise HTTPException(
            status_code=403,
            detail="No character found for this account. Ask your GM to add you to the session.",
        )

    # 3. Verify password against stored bcrypt hash — no ScenePlay call needed
    stored_hash = existing.get("password_hash") or ""
    if not stored_hash:
        raise HTTPException(
            status_code=503,
            detail="Credentials not synced yet. Ask your GM to sync the party.",
        )
    if not _verify_password(request.password, stored_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    display_name = existing.get("display_name") or username
    portrait_url = existing.get("portrait_url") or ""
    sheet_json   = existing["sheet_json"]
    hp_current   = existing["hp_current"]
    hp_max       = existing["hp_max"]

    # 4. Mark joined, issue token, broadcast
    await db.mark_character_joined(existing["id"])
    token = issue_player_token(existing["id"], display_name, session["id"], username)

    await publish(session["id"], {
        "type": "player_joined",
        "data": {
            "character_id": existing["id"],
            "player_name":  existing["player_name"],
            "username":     username,
            "display_name": display_name,
            "portrait_url": portrait_url,
            "hp_current":   hp_current,
            "hp_max":       hp_max,
        },
    })

    try:
        sheet = json.loads(sheet_json)
    except Exception:
        sheet = {}

    return JoinResponse(token=token, character={"sheet": sheet, "hp_current": hp_current, "hp_max": hp_max})


@router.post("/character")
async def save_character(request: CharacterRequest, player: dict = Depends(_get_player)):
    sheet_str = json.dumps(request.sheet)
    await db.upsert_character(
        player["sub"],
        player["session_id"],
        player["player_name"],
        sheet_str,
        request.hp_current,
        request.hp_max,
    )
    await publish(player["session_id"], {
        "type": "character_saved",
        "data": {"player_id": player["sub"], "player_name": player["player_name"]},
    })
    return {"ok": True}


@router.post("/character/hp-delta")
async def hp_delta(request: HpDeltaRequest, player: dict = Depends(_get_player)):
    target_id = request.character_id or player["sub"]
    char = await db.get_character(target_id)
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")
    # Verify the target character belongs to the logged-in user
    if target_id != player["sub"] and char.get("username") != player.get("username"):
        raise HTTPException(status_code=403, detail="Not your character")
    hp_max = char["hp_max"] or 1
    new_hp = max(0, min(hp_max, (char["hp_current"] or 0) + request.delta))
    await db.update_character_hp(target_id, new_hp, hp_max)

    await publish(player["session_id"], {
        "type": "character_hp_update",
        "data": {
            "character_id": target_id,
            "hp_current":   new_hp,
            "hp_max":       hp_max,
        },
    })
    # Also update the battlemap token HP bar if this player has a token
    tok = await db.get_token_by_character(target_id)
    if tok:
        await publish(player["session_id"], {
            "type": "health_update",
            "data": {"token_id": tok["id"], "hp_current": new_hp, "hp_max": hp_max},
        })
    return {"ok": True, "hp_current": new_hp, "hp_max": hp_max}


@router.post("/character/password")
async def change_password(request: ChangePasswordRequest, player: dict = Depends(_get_player)):
    char = await db.get_character(player["sub"])
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")
    stored_hash = char.get("password_hash") or ""
    if not stored_hash or not _verify_password(request.old_password, stored_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    new_hash = _bcrypt.hashpw(
        request.new_password.encode("utf-8"), _bcrypt.gensalt()
    ).decode("utf-8")
    await db.update_character_password(player["sub"], new_hash)
    return {"ok": True}


@router.post("/heartbeat")
async def heartbeat(player: dict = Depends(_get_player)):
    """Players call this every 30 s to refresh their online presence."""
    mark_present(player["session_id"], player["sub"], player.get("player_name", "?"))
    return {"ok": True}


@router.post("/character/mutate")
async def submit_mutation(request: MutationRequest, player: dict = Depends(_get_player)):
    mutation_data = json.dumps(request.data)
    mutation_id = await db.insert_mutation(
        player["session_id"],
        player["player_name"],
        request.mutation_type,
        mutation_data,
    )
    return {"ok": True, "mutation_id": mutation_id}


@router.post("/character/portrait")
async def upload_portrait(request: PortraitUploadRequest, player: dict = Depends(_get_player)):
    import base64
    char = await db.get_character(player["sub"])
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")
    ext = request.portrait_ext.lstrip(".").lower() or "png"
    filename = f"{player['sub']}.{ext}"
    os.makedirs(_PORTRAITS_DIR, exist_ok=True)
    portrait_path = os.path.join(_PORTRAITS_DIR, filename)
    try:
        raw = base64.b64decode(request.portrait_data)
        with open(portrait_path, "wb") as f:
            f.write(raw)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid portrait data: {exc}")
    portrait_url = f"/portraits/{filename}"
    # Update the character record with the new portrait URL
    await db.database.execute(
        "UPDATE characters SET portrait_url = :pu, updated_at = :ts WHERE id = :id",
        {"pu": portrait_url, "ts": db._now(), "id": player["sub"]},
    )
    # Queue a portrait_upload mutation so local picks up the new portrait
    await db.insert_mutation(
        player["session_id"],
        player["player_name"],
        "portrait_upload",
        json.dumps({"portrait_url": portrait_url}),
    )
    await publish(player["session_id"], {
        "type": "character_portrait_updated",
        "data": {"player_name": player["player_name"], "portrait_url": portrait_url},
    })
    return {"ok": True, "portrait_url": portrait_url}


@router.get("/library")
async def get_library(player: dict = Depends(_get_player)):
    row = await db.get_library(player["session_id"])
    if not row:
        return {"ok": True, "library": {}}
    return {"ok": True, "library": json.loads(row["library_json"])}


@router.post("/roll")
async def submit_roll(request: RollRequest, player: dict = Depends(_get_player)):
    await db.insert_roll(
        player["session_id"],
        player["player_name"],
        request.roll_expr,
        request.result,
        request.breakdown,
    )
    await publish(player["session_id"], {
        "type": "roll_result",
        "data": {
            "player":      player["player_name"],
            "player_name": player["player_name"],
            "roll":        request.roll_expr,
            "roll_expr":   request.roll_expr,
            "result":      request.result,
            "breakdown":   request.breakdown,
        },
    })
    # Write to ScenePlay's dice history so local players see relay rolls too
    await asyncio.to_thread(
        _write_to_sp_db,
        player["player_name"], request.roll_expr, request.result, request.breakdown,
    )
    return {"ok": True}
