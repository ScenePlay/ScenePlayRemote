import asyncio
import json
import os
import re
import sqlite3
import time
from collections import deque
from datetime import datetime, timezone

import bcrypt as _bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import db
import gm_link
from auth import issue_player_token, verify_player_token
from broadcast import publish, mark_present
from models import (JoinRequest, JoinResponse, RollRequest,
                    ChangePasswordRequest, LedDeviceRequest, MutationRequest,
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


# Simple in-memory per-IP limiter for /join — the only unauthenticated,
# internet-facing endpoint that checks a password, so it's the brute-force
# target. 10 attempts per rolling minute per IP. Resets on process restart,
# which is fine for this scale.
_JOIN_LIMIT, _JOIN_WINDOW_S = 10, 60
_join_attempts: dict = {}   # ip -> deque[timestamps]


def _join_rate_ok(ip: str) -> bool:
    now = time.monotonic()
    dq = _join_attempts.setdefault(ip, deque())
    while dq and now - dq[0] > _JOIN_WINDOW_S:
        dq.popleft()
    if len(dq) >= _JOIN_LIMIT:
        return False
    dq.append(now)
    if len(_join_attempts) > 1000:   # bound memory across many IPs
        _join_attempts.clear()
    return True


@router.post("/join", response_model=JoinResponse)
async def join(request: JoinRequest, http_request: Request):
    client_ip = http_request.client.host if http_request.client else 'unknown'
    if not _join_rate_ok(client_ip):
        raise HTTPException(status_code=429,
                            detail="Too many join attempts — wait a minute and try again.")

    # 1. Resolve session by join code
    session = await db.get_session_by_code(request.code.upper().strip())
    if not session:
        raise HTTPException(status_code=404, detail="Invalid join code")

    # 2. Find character record by username (relay-local lookup)
    username = request.name.strip()
    existing = await db.get_character_by_username(session["id"], username)
    if not existing:
        # No character yet — allow a SPECTATOR login against the pushed user
        # accounts. The moment the GM assigns them a character it lights up
        # live (character_upserted), no re-login needed.
        user = await db.get_session_user(session["id"], username)
        if not user:
            raise HTTPException(
                status_code=403,
                detail="No account found for this session. Ask your GM to press Sync in Relay settings.",
            )
        stored_hash = user.get("password_hash") or ""
        if not stored_hash:
            raise HTTPException(
                status_code=503,
                detail="Credentials not synced yet. Ask your GM to sync the party.",
            )
        if not _verify_password(request.password, stored_hash):
            raise HTTPException(status_code=401, detail="Invalid username or password")
        display_name = user.get("display_name") or username
        token = issue_player_token(
            f"user:{username}", display_name, session["id"], username)
        return JoinResponse(token=token, character=None)

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


# NOTE: HP changes from the portal are staged as an `hp_delta` mutation via
# /character/mutate. Local Flask is the authority — it applies the delta against
# its own hp_max and pushes the authoritative HP back (character_sheet_updated).
# The relay never computes or owns HP. The old /character (save) and
# /character/hp-delta endpoints were removed because they let the relay become
# authoritative for character state, violating the local-authority law.


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
    # Mutations MUST be keyed by the character name (char["player_name"]), which is
    # how local's receiver and the portal both look characters up. The JWT's
    # player_name is the player's DISPLAY name (e.g. "Callan") and will not match
    # the character (e.g. "Katia Grim"), so the receiver would silently skip it.
    #
    # as_player targets a specific character owned by this login — required for
    # multi-character players (sheet edits used to always hit the LOGIN
    # character) and for spectator logins that were assigned a character later.
    char = None
    if request.as_player:
        target = await db.get_character_by_player_name(
            player["session_id"], request.as_player)
        if target and target.get("username") \
                and target["username"] == player.get("username"):
            char = target
    if char is None:
        char = await db.get_character(player["sub"])
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")
    mutation_data = json.dumps(request.data)
    mutation_id = await db.insert_mutation(
        player["session_id"],
        char["player_name"],
        request.mutation_type,
        mutation_data,
    )
    # GM link: push the mutation immediately instead of waiting for the GM
    # box's next poll. Row shape mirrors db.get_pending_mutations so the GM
    # side applies it through identical code.
    gm_link.emit(player["session_id"], {"type": "mutation", "data": {
        "id": mutation_id,
        "session_id": player["session_id"],
        "player_name": char["player_name"],
        "mutation_type": request.mutation_type,
        "mutation_data": mutation_data,
        "applied": 0,
    }})
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
    # Queue a portrait_upload mutation so local picks up the new portrait.
    # Key by the character name (not the JWT display name) so the receiver matches.
    _pm_data = json.dumps({"portrait_url": portrait_url})
    _pm_id = await db.insert_mutation(
        player["session_id"],
        char["player_name"],
        "portrait_upload",
        _pm_data,
    )
    gm_link.emit(player["session_id"], {"type": "mutation", "data": {
        "id": _pm_id,
        "session_id": player["session_id"],
        "player_name": char["player_name"],
        "mutation_type": "portrait_upload",
        "mutation_data": _pm_data,
        "applied": 0,
    }})
    await publish(player["session_id"], {
        "type": "character_portrait_updated",
        "data": {"player_name": char["player_name"], "portrait_url": portrait_url},
    })
    return {"ok": True, "portrait_url": portrait_url}


def _device_username(player: dict) -> str:
    """Stable key for a player's home devices. `username` is present in every
    JWT (including spectator logins); display name is the last resort."""
    return player.get("username") or player.get("player_name") or ""


def _normalize_device_url(url: str, default_port: int | None) -> str:
    """Accept bare '192.168.1.50', add scheme/port, reject anything that
    isn't a plain http(s) host[:port]. Empty input stays empty (= clear)."""
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    if not re.match(r"^https?://", url):
        url = f"http://{url}"
    if default_port and ":" not in url.split("//", 1)[1]:
        url += f":{default_port}"
    if not re.match(r"^https?://[A-Za-z0-9_.\-]+(:\d+)?$", url):
        raise HTTPException(status_code=422, detail=f"Invalid device address: {url}")
    return url


@router.get("/session-check")
async def session_check(player: dict = Depends(_get_player)):
    """Cheap resume probe: valid token AND the session still exists. The
    portal calls this before re-entering the app with a stored JWT, so a
    token for a deleted/replaced session lands on the login screen instead
    of a dead app screen."""
    session = await db.get_session_by_id(player["session_id"])
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}


@router.get("/led-device")
async def get_led_device(player: dict = Depends(_get_player)):
    import mqtt_bridge
    username = _device_username(player)
    if not username:
        return {"pi_url": "", "wled_url": "", "mqtt": False,
                **mqtt_bridge.player_mqtt_info("")}
    devices = await db.get_led_device(username)
    devices.update(mqtt_bridge.player_mqtt_info(username))
    return devices


@router.post("/led-device")
async def set_led_device(request: LedDeviceRequest, player: dict = Depends(_get_player)):
    import mqtt_bridge
    username = _device_username(player)
    if not username:
        raise HTTPException(status_code=400, detail="No username on this login")
    pi_url   = _normalize_device_url(request.pi_url, 8086)   # ScenePlay LED port
    wled_url = _normalize_device_url(request.wled_url, None)  # WLED serves on 80
    mqtt_on  = bool(request.mqtt) and mqtt_bridge.enabled()
    await db.upsert_led_device(username, pi_url, wled_url, mqtt_on)
    return {"ok": True, "pi_url": pi_url, "wled_url": wled_url,
            "mqtt": mqtt_on, **mqtt_bridge.player_mqtt_info(username)}


@router.get("/library")
async def get_library(player: dict = Depends(_get_player)):
    row = await db.get_library(player["session_id"])
    if not row:
        return {"ok": True, "library": {}}
    return {"ok": True, "library": json.loads(row["library_json"])}


@router.post("/roll")
async def submit_roll(request: RollRequest, player: dict = Depends(_get_player)):
    # Attribute the roll to another character IF it belongs to the same login
    # (one player can run several characters). Falls back to the JWT identity
    # on any mismatch rather than erroring — a roll should never be lost.
    roll_as = player["player_name"]
    if request.as_player and request.as_player != roll_as:
        target = await db.get_character_by_player_name(
            player["session_id"], request.as_player)
        if target and target.get("username") \
                and target["username"] == player.get("username"):
            roll_as = request.as_player

    roll_id = await db.insert_roll(
        player["session_id"],
        roll_as,
        request.roll_expr,
        request.result,
        request.breakdown,
    )
    await publish(player["session_id"], {
        "type": "roll_result",
        "data": {
            "player":      roll_as,
            "player_name": roll_as,
            "roll":        request.roll_expr,
            "roll_expr":   request.roll_expr,
            "result":      request.result,
            "breakdown":   request.breakdown,
        },
    })
    # GM link: roll_log-row shape incl. relay id — the GM box's dedup and
    # local-echo claim key on it, same as the /sync roll_log path.
    gm_link.emit(player["session_id"], {"type": "roll_result", "data": {
        "id": roll_id,
        "session_id": player["session_id"],
        "player_name": roll_as,
        "roll_expr": request.roll_expr,
        "result": request.result,
        "breakdown": request.breakdown,
        "rolled_at": db._now(),
    }})
    # Write to ScenePlay's dice history so local players see relay rolls too
    await asyncio.to_thread(
        _write_to_sp_db,
        roll_as, request.roll_expr, request.result, request.breakdown,
    )
    return {"ok": True}
