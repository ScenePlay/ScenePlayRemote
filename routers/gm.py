import json
import os
import random
import sqlite3
import string
import uuid

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import db
from auth import verify_gm_secret
from broadcast import publish, get_presence
from models import (CharacterBulkPushRequest, ConditionUpdateRequest, GenerateCodeResponse,
                    PushRequest, MutationAckRequest, LibraryPushRequest, SheetBroadcastRequest, UsersBulkPushRequest)

router = APIRouter()

_PORTRAIT_DIR  = os.path.join(os.path.dirname(__file__), '..', 'portal', 'portraits')
_BATTLEMAP_DIR = os.path.join(os.path.dirname(__file__), '..', 'portal', 'battlemaps')
_MONSTER_DIR   = os.path.join(os.path.dirname(__file__), '..', 'portal', 'monsters')

_SCENPLAY_DB = os.path.join(os.path.dirname(__file__), '..', '..', 'ScenePlay', 'ScenePlay.db')


def _fetch_monster_images(entity_ids: list) -> dict:
    """Return {entity_id: full_image_url} for the given monster entity_ids from ScenePlay DB."""
    if not entity_ids or not os.path.exists(_SCENPLAY_DB):
        return {}
    try:
        conn = sqlite3.connect(_SCENPLAY_DB)
        ph = ','.join('?' * len(entity_ids))
        rows = conn.execute(f'''
            SELECT sm.monster_id, json_extract(mt.stats_json, "$.image") AS img
            FROM tblSessionMonsters sm
            JOIN tblMonsterTemplates mt ON sm.template_id = mt.template_id
            WHERE sm.monster_id IN ({ph})
        ''', entity_ids).fetchall()
        conn.close()
        return {mid: 'https://www.dnd5eapi.co' + img
                for mid, img in rows if img}
    except Exception:
        return {}


async def _resolve_portrait(char) -> str:
    """Return a relay-local portrait path for a character push entry.

    Prefers base64 payload data (works for remote relay); falls back to
    downloading from portrait_url if data is absent."""
    import base64, hashlib
    if char.portrait_data:
        ext = (char.portrait_ext or 'png').lstrip('.')
        raw = base64.b64decode(char.portrait_data)
        filename = hashlib.sha256(raw).hexdigest()[:32] + '.' + ext
        os.makedirs(_PORTRAIT_DIR, exist_ok=True)
        local_path = os.path.join(_PORTRAIT_DIR, filename)
        if not os.path.exists(local_path):
            with open(local_path, 'wb') as f:
                f.write(raw)
        return f'/portraits/{filename}'
    return await _localise_portrait(char.portrait_url or '')


def _prune_battlemaps(keep: str) -> None:
    """Delete every stored battlemap file except `keep` — relay hosts (Render)
    have small disks, so only the CURRENT map's background is kept. A map the
    GM switches back to later is simply re-sent by ScenePlay (need_image)."""
    try:
        for f in os.listdir(_BATTLEMAP_DIR):
            if f == keep or f.startswith('.'):
                continue
            try:
                os.remove(os.path.join(_BATTLEMAP_DIR, f))
            except OSError:
                pass
    except OSError:
        pass


async def _resolve_battlemap(map_data: dict) -> tuple[str, bool]:
    """Resolve a map push's background to a relay-local URL.

    Returns (url, need_image). Resolution order:
      1. image_sha names a file already on disk  -> reuse it (no bytes sent).
      2. image_data (base64) in the payload      -> write it (sha-named).
      3. download map url (co-located relay)     -> keep original filename.
      4. sha offered but nothing worked          -> need_image=True: ScenePlay
         re-sends the push with the bytes included.
    Old battlemap files are pruned whenever a current file is resolved."""
    import base64, hashlib
    ext = (map_data.get('image_ext') or 'png').lstrip('.')
    sha = map_data.get('image_sha') or ''

    if sha:
        filename = f'{sha}.{ext}'
        if os.path.exists(os.path.join(_BATTLEMAP_DIR, filename)):
            _prune_battlemaps(filename)
            return f'/battlemaps/{filename}', False

    data = map_data.get('image_data')
    if data:
        try:
            raw = base64.b64decode(data)
            filename = hashlib.sha256(raw).hexdigest()[:32] + '.' + ext
            os.makedirs(_BATTLEMAP_DIR, exist_ok=True)
            _prune_battlemaps(filename)   # free space BEFORE writing
            local_path = os.path.join(_BATTLEMAP_DIR, filename)
            if not os.path.exists(local_path):
                with open(local_path, 'wb') as f:
                    f.write(raw)
            return f'/battlemaps/{filename}', False
        except Exception:
            # Can't store it (disk full?). Do NOT fall back to the payload's
            # data: URL — a multi-MB URL stored in map_json bloats every
            # /sync response and SSE event enough to stall the whole pipeline.
            # Serve the map with no background instead; tokens keep working.
            return '', False

    if sha:
        # ScenePlay holds embeddable bytes for this map (sha offered) but we
        # don't have the file. Answer need_image IMMEDIATELY — attempting the
        # LAN-url download first stalls up to 30s, longer than ScenePlay's
        # push timeout, deadlocking the handshake on a remote relay.
        return '', True

    url = map_data.get('url') or ''
    resolved = await _localise_battlemap(url)
    if resolved.startswith('/battlemaps/'):
        _prune_battlemaps(resolved.rsplit('/', 1)[-1])
    return resolved, False


def _random_code(length: int = 6) -> str:
    chars = string.ascii_uppercase + string.digits
    return "".join(random.choices(chars, k=length))


async def _localise_file(url: str, local_dir: str, url_prefix: str) -> str:
    """Download a file from ScenePlay into local_dir and return a relay-local URL.
    Falls back to the original URL if the download fails."""
    if not url:
        return url
    try:
        filename = url.rstrip('/').split('/')[-1]
        os.makedirs(local_dir, exist_ok=True)
        local_path = os.path.join(local_dir, filename)
        if not os.path.exists(local_path):
            async with httpx.AsyncClient() as client:
                r = await client.get(url, timeout=30.0, follow_redirects=True)
                r.raise_for_status()
                with open(local_path, 'wb') as f:
                    f.write(r.content)
        return f'{url_prefix}/{filename}'
    except Exception:
        return url  # fall back to original URL when ScenePlay is reachable


def _localise_portrait(url: str):
    return _localise_file(url, _PORTRAIT_DIR, '/portraits')


def _localise_battlemap(url: str):
    return _localise_file(url, _BATTLEMAP_DIR, '/battlemaps')


def _localise_monster_image(url: str):
    return _localise_file(url, _MONSTER_DIR, '/monsters')


@router.post("/session/create", response_model=GenerateCodeResponse)
async def generate_code(x_relay_secret: str = Header(...)):
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    await db.purge_all_sessions()
    session_id = str(uuid.uuid4())
    code = _random_code()
    await db.create_session(session_id, code)
    return GenerateCodeResponse(session_id=session_id, code=code)


@router.post("/session/push")
async def push_session(request: PushRequest, x_relay_secret: str = Header(...)):
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    session = await db.get_session_by_id(request.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Scene first: it must survive even when the map half of a combined push
    # bails out below with need_image.
    scene_str = json.dumps(request.scene) if request.scene is not None else None
    if scene_str is not None:
        await db.update_session_state(request.session_id, scene_str, None)
        await publish(request.session_id, {"type": "scene_update", "data": request.scene})

    map_data = None
    if request.map is not None:
        map_data = dict(request.map)
        map_data['url'], need_image = await _resolve_battlemap(map_data)
        if need_image:
            # We can't serve this background yet — keep the previous MAP state
            # untouched and ask ScenePlay for the push WITH image bytes.
            return {"ok": True, "need_image": True}
        # Drop the transfer fields so they never bloat map_json / the SSE broadcast
        map_data.pop('image_data', None)
        map_data.pop('image_ext', None)
        map_data.pop('image_sha', None)
        # Map CHANGE (different token set than the stored map): clear the
        # incremental token-move rows — they describe the previous map and
        # would be echoed back onto the new map's tokens by label.
        try:
            prev_ids = {t.get('token_id')
                        for t in json.loads(session.get('map_json') or '{}').get('tokens', [])}
            new_ids = {t.get('token_id') for t in map_data.get('tokens') or []}
            if new_ids != prev_ids:
                await db.clear_token_positions(request.session_id)
        except (ValueError, TypeError):
            pass
        if map_data.get('tokens'):
            # Fill in missing image_url for monster tokens by looking up ScenePlay DB
            missing = [t for t in map_data['tokens']
                       if (t.get('token_type') == 'monster' or t.get('entity_type') == 'monster')
                       and not t.get('image_url')]
            if missing:
                img_map = _fetch_monster_images([t['entity_id'] for t in missing])
                for tok in missing:
                    url = img_map.get(tok['entity_id'])
                    if url:
                        tok['image_url'] = url
            # Localise all monster image URLs to relay-local paths
            for tok in map_data['tokens']:
                if tok.get('image_url'):
                    tok['image_url'] = await _localise_monster_image(tok['image_url'])
    map_str = json.dumps(map_data) if map_data is not None else None
    if map_str is not None:
        await db.update_session_state(request.session_id, None, map_str)
        await publish(request.session_id, {"type": "map_update", "data": {"map_json": map_str}})

    return {"ok": True}


@router.post("/session/{session_id}/characters")
async def push_characters(
    session_id: str,
    request: CharacterBulkPushRequest,
    x_relay_secret: str = Header(...),
):
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    session = await db.get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    for char in request.characters:
        local_portrait = await _resolve_portrait(char)
        char_id = await db.upsert_character_by_name(
            session_id,
            char.player_name,
            char.username,
            char.display_name,
            char.sheet_json,
            char.hp_current,
            char.hp_max,
            local_portrait,
            char.password_hash,
        )
        # Tell connected portals immediately — without this, new/edited/
        # reassigned characters were invisible until everyone re-logged in.
        await publish(session_id, {
            "type": "character_upserted",
            "data": {
                "id":           char_id,
                "character_id": char_id,
                "player_name":  char.player_name,
                "username":     char.username,
                "display_name": char.display_name,
                "portrait_url": local_portrait or "",
                "hp_current":   char.hp_current,
                "hp_max":       char.hp_max,
                "sheet_json":   char.sheet_json,
            },
        })

    return {"ok": True, "upserted": len(request.characters)}


class PushRollRequest(BaseModel):
    player_name: str
    roll_expr:   str
    result:      int
    breakdown:   str = ""


@router.post("/session/{session_id}/users")
async def push_users(
    session_id: str,
    request: UsersBulkPushRequest,
    x_relay_secret: str = Header(...),
):
    """User accounts from local — lets a player log in BEFORE any character is
    assigned to them (they become a spectator until the GM assigns a sheet)."""
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    session = await db.get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    for u in request.users:
        await db.upsert_session_user(
            session_id, u.username, u.display_name, u.password_hash)
    return {"ok": True, "upserted": len(request.users)}


@router.post("/session/{session_id}/push-roll")
async def push_roll(
    session_id: str,
    request: PushRollRequest,
    x_relay_secret: str = Header(...),
):
    """Receive a local ScenePlay dice roll and broadcast it to relay clients."""
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    await db.insert_roll(
        session_id,
        request.player_name,
        request.roll_expr,
        request.result,
        request.breakdown,
    )
    await publish(session_id, {
        "type": "roll_result",
        "data": {
            "player_name": request.player_name,
            "player":      request.player_name,
            "roll_expr":   request.roll_expr,
            "roll":        request.roll_expr,
            "result":      request.result,
            "breakdown":   request.breakdown,
        },
    })
    return {"ok": True}


@router.get("/session/{session_id}/presence")
async def presence(
    session_id: str,
    x_relay_secret: str = Header(...),
):
    """Return {player_name: seconds_since_last_seen} for all online players."""
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    return {"presence": get_presence(session_id)}


@router.get("/session/{session_id}/rolls")
async def get_rolls(
    session_id: str,
    since_id: int = 0,
    x_relay_secret: str = Header(...),
):
    """Return roll_log entries newer than since_id so the local server can poll them."""
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    rolls = await db.get_rolls_since(session_id, since_id)
    return {"rolls": rolls}


@router.post("/session/{session_id}/condition-update")
async def condition_update(
    session_id: str,
    request: ConditionUpdateRequest,
    x_relay_secret: str = Header(...),
):
    """Broadcast targeted condition changes to all SSE subscribers for this session."""
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    data: dict = {'conditions': request.conditions}
    if request.token_id:
        data['token_id'] = request.token_id
    if request.player_name:
        data['player_name'] = request.player_name
    await publish(session_id, {"type": "condition_update", "data": data})
    return {"ok": True}


@router.post("/session/{session_id}/mutations/ack")
async def ack_mutations(
    session_id: str,
    request: MutationAckRequest,
    x_relay_secret: str = Header(...),
):
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    await db.ack_mutations(request.mutation_ids)
    return {"ok": True, "acked": len(request.mutation_ids)}


@router.post("/session/{session_id}/library")
async def push_library(
    session_id: str,
    request: LibraryPushRequest,
    x_relay_secret: str = Header(...),
):
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    session = await db.get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    library_json = json.dumps({
        "spells":    request.spells,
        "feats":     request.feats,
        "weapons":   request.weapons,
        "armor":     request.armor,
        "equipment": request.equipment,
        "skills":    request.skills,
        "races":     request.races,
        "classes":   request.classes,
        "conditions":        request.conditions,
        "magic_items":       request.magic_items,
        "features":          request.features,
        "class_levels":      request.class_levels,
        "subclasses":        request.subclasses,
        "traits":            request.traits,
        "weapon_properties": request.weapon_properties,
        "rules":             request.rules,
    })
    await db.upsert_library(session_id, library_json)
    return {"ok": True}


@router.post("/session/{session_id}/character-sheet-broadcast")
async def broadcast_sheet(
    session_id: str,
    request: SheetBroadcastRequest,
    x_relay_secret: str = Header(...),
):
    """Called by local server after applying mutations — broadcasts authoritative sheet_json to portal."""
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    char = await db.get_character_by_player_name(session_id, request.player_name)
    if char:
        await publish(session_id, {
            "type": "character_sheet_updated",
            "data": {
                "player_name": request.player_name,
                "sheet_json":  char["sheet_json"],
                "hp_current":  char["hp_current"],
                "hp_max":      char["hp_max"],
                "portrait_url": char.get("portrait_url") or "",
            },
        })
    return {"ok": True}


@router.delete("/session/{session_id}/characters/{player_name}")
async def delete_character(
    session_id: str,
    player_name: str,
    x_relay_secret: str = Header(...),
):
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    session = await db.get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    deleted = await db.delete_character_by_name(session_id, player_name)
    if not deleted:
        raise HTTPException(status_code=404, detail="Character not found")
    await publish(session_id, {"type": "character_removed", "data": {"player_name": player_name}})
    return {"ok": True}


