import asyncio
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
from broadcast import publish
from models import CharacterBulkPushRequest, GenerateCodeResponse, PushRequest

router = APIRouter()

_PORTRAIT_DIR  = os.path.join(os.path.dirname(__file__), '..', 'portal', 'portraits')
_BATTLEMAP_DIR = os.path.join(os.path.dirname(__file__), '..', 'portal', 'battlemaps')
_MONSTER_DIR   = os.path.join(os.path.dirname(__file__), '..', 'portal', 'monsters')

# Path to ScenePlay DB — used to look up monster images when the push omits image_url
_SCENPLAY_DB = os.path.join(os.path.dirname(__file__), '..', '..', 'ScenePlay', 'ScenePlay.db')


def _fetch_sp_effects() -> list[dict]:
    """Read current effects for the active battlemap from ScenePlay's DB."""
    if not os.path.exists(_SCENPLAY_DB):
        return []
    try:
        conn = sqlite3.connect(_SCENPLAY_DB, timeout=2.0)
        rows = conn.execute(
            """SELECT e.effect_id, e.shape, COALESCE(e.label,''),
                      e.anchor_x, e.anchor_y, e.size_ft, e.angle,
                      e.fill_color, e.fill_opacity, e.border_color
               FROM tblBattleMapEffects e
               JOIN tblBattleMaps bm ON e.map_id = bm.map_id
               JOIN tblSessions s ON bm.session_id = s.session_id
               WHERE bm.is_active = 1 AND s.status = 'active'"""
        ).fetchall()
        conn.close()
        return [
            { 'effect_id': r[0], 'shape': r[1], 'label': r[2],
              'anchor_x': r[3], 'anchor_y': r[4], 'size_ft': r[5],
              'angle': r[6], 'fill_color': r[7], 'fill_opacity': r[8],
              'border_color': r[9] }
            for r in rows
        ]
    except Exception:
        return []


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

    scene_str = json.dumps(request.scene) if request.scene is not None else None

    map_data = None
    if request.map is not None:
        map_data = dict(request.map)
        if map_data.get('url'):
            map_data['url'] = await _localise_battlemap(map_data['url'])
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
        # Always inject current effects from ScenePlay DB (overrides whatever was pushed)
        if map_data is not None:
            map_data['effects'] = await asyncio.to_thread(_fetch_sp_effects)
    map_str = json.dumps(map_data) if map_data is not None else None

    await db.update_session_state(request.session_id, scene_str, map_str)

    if request.scene is not None:
        await publish(request.session_id, {"type": "scene_update", "data": request.scene})
    if map_str is not None:
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
        local_portrait = await _localise_portrait(char.portrait_url or '')
        await db.upsert_character_by_name(
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

    return {"ok": True, "upserted": len(request.characters)}


class PushRollRequest(BaseModel):
    player_name: str
    roll_expr:   str
    result:      int
    breakdown:   str = ""


@router.post("/session/{session_id}/push-roll")
async def push_roll(
    session_id: str,
    request: PushRollRequest,
    x_relay_secret: str = Header(...),
):
    """Receive a local ScenePlay dice roll and broadcast it to relay clients."""
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
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
