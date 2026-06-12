import asyncio
import json
import os
import re
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sse_starlette.sse import EventSourceResponse

import db
from auth import verify_player_token
from broadcast import publish, subscribe, unsubscribe

router = APIRouter()
_bearer = HTTPBearer(auto_error=False)

_PING_INTERVAL = 30  # seconds
_SP_POLL       = 4   # seconds between ScenePlay DB checks

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


def _inject_effects(map_json_str: str | None) -> str | None:
    """Augment a stored map_json string with live effects from ScenePlay DB."""
    if not map_json_str:
        return map_json_str
    try:
        m = json.loads(map_json_str)
        m['effects'] = _fetch_sp_effects()
        return json.dumps(m)
    except Exception:
        return map_json_str


def _sp_latest_roll_id() -> int:
    """Return the current max roll_id in ScenePlay DB (used to skip historical rolls on connect)."""
    if not os.path.exists(_SCENPLAY_DB):
        return 0
    try:
        conn = sqlite3.connect(_SCENPLAY_DB, timeout=2.0)
        row = conn.execute("SELECT COALESCE(MAX(roll_id), 0) FROM tblDiceRolls").fetchone()
        conn.close()
        return row[0] if row else 0
    except Exception:
        return 0


def _sp_rolls_since(last_id: int) -> tuple[list[dict], int]:
    """Return (new_roll_events, new_last_id) for ScenePlay rolls after last_id.
    Excludes relay-written rolls (character_id = -1)."""
    if not os.path.exists(_SCENPLAY_DB):
        return [], last_id
    try:
        conn = sqlite3.connect(_SCENPLAY_DB, timeout=2.0)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """SELECT roll_id, char_name, expression, label, dice_json, modifier, total, adv_mode
               FROM tblDiceRolls
               WHERE roll_id > ? AND (character_id IS NULL OR character_id != -1)
               ORDER BY roll_id ASC""",
            (last_id,),
        ).fetchall()
        conn.close()
    except Exception:
        return [], last_id

    results, new_last = [], last_id
    for r in rows:
        new_last = max(new_last, r["roll_id"])
        try:
            dice = json.loads(r["dice_json"] or "[]")
        except Exception:
            dice = []
        mod = r["modifier"] or 0
        breakdown = ", ".join(str(d) for d in dice)
        if mod > 0:
            breakdown += f"+{mod}"
        elif mod < 0:
            breakdown += str(mod)
        roll_expr = r["expression"] or "d20"
        if r["label"]:
            roll_expr += " " + r["label"]
        results.append({
            "player_name": r["char_name"] or "GM",
            "player":      r["char_name"] or "GM",
            "roll_expr":   roll_expr,
            "roll":        r["expression"] or "d20",
            "result":      r["total"],
            "breakdown":   breakdown,
        })
    return results, new_last


@router.get("/session/{session_id}/stream")
async def stream(
    session_id: str,
    token: Optional[str] = None,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
):
    raw = token or (credentials.credentials if credentials else None)
    if not raw:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = verify_player_token(raw)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc))

    if payload["session_id"] != session_id:
        raise HTTPException(status_code=403, detail="Token not valid for this session")

    session = await db.get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    tokens     = await db.get_tokens_for_session(session_id)
    characters = await db.get_characters_for_session(session_id)
    rolls      = await db.get_rolls_for_session(session_id, limit=40)

    # Snapshot the current ScenePlay roll cursor so we only forward NEW rolls
    last_sp_id = await asyncio.to_thread(_sp_latest_roll_id)

    map_json_with_effects = await asyncio.to_thread(
        _inject_effects, session.get("map_json")
    )

    q = subscribe(session_id)
    await q.put({
        "type": "session_state",
        "data": {
            "tokens":     tokens,
            "characters": characters,
            "map_json":   map_json_with_effects,
            "rolls":      list(reversed(rolls)),
        },
    })

    async def generator():
        nonlocal last_sp_id
        last_ping = asyncio.get_event_loop().time()
        last_poll = asyncio.get_event_loop().time()

        try:
            while True:
                now  = asyncio.get_event_loop().time()
                wait = max(0.5, min(_SP_POLL, last_ping + _PING_INTERVAL - now))
                try:
                    event = await asyncio.wait_for(q.get(), timeout=wait)
                    yield {"data": json.dumps(event)}
                except asyncio.TimeoutError:
                    pass

                now = asyncio.get_event_loop().time()

                # Poll ScenePlay DB for new local-player rolls
                if now - last_poll >= _SP_POLL:
                    sp_rolls, last_sp_id = await asyncio.to_thread(_sp_rolls_since, last_sp_id)
                    for roll in sp_rolls:
                        yield {"data": json.dumps({"type": "roll_result", "data": roll})}
                    last_poll = now

                # Ping to keep connection alive
                if now - last_ping >= _PING_INTERVAL:
                    yield {"data": json.dumps({"type": "ping", "data": {}})}
                    last_ping = now

        except GeneratorExit:
            pass
        finally:
            unsubscribe(session_id, q)

    return EventSourceResponse(generator())
