import asyncio
import json
import os
import re
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sse_starlette.sse import EventSourceResponse

import audio_hub
import db
from auth import verify_player_token
from broadcast import publish, subscribe, unsubscribe, mark_present, mark_absent

router = APIRouter()
_bearer = HTTPBearer(auto_error=False)

_PING_INTERVAL = 30  # seconds
_SP_POLL       = 4   # seconds between ScenePlay DB checks

_SCENPLAY_DB = os.path.join(os.path.dirname(__file__), '..', '..', 'ScenePlay', 'ScenePlay.db')


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
    rolls      = await db.get_rolls_for_session(session_id, limit=50)

    # Resolve the character's display name for presence tracking
    char_record = await db.get_character(payload["sub"])
    char_name   = char_record["player_name"] if char_record else payload.get("player_name", "?")

    # Snapshot the current ScenePlay roll cursor so we only forward NEW rolls
    last_sp_id = await asyncio.to_thread(_sp_latest_roll_id)

    # Mark player online and notify everyone
    mark_present(session_id, payload["sub"], char_name)
    await publish(session_id, {
        "type": "player_online",
        "data": {"player_name": char_name},
    })

    # Current lighting state + this player's home device addresses, so a
    # late joiner's browser can light their room to match without waiting
    # for the next scene change.
    led = wled = None
    try:
        if session.get("led_json"):
            led = dict(json.loads(session["led_json"]),
                       seq=session.get("led_seq") or 0)
        if session.get("wled_json"):
            wled = dict(json.loads(session["wled_json"]),
                        seq=session.get("wled_seq") or 0)
    except (ValueError, TypeError):
        led = wled = None
    led_devices = await db.get_led_device(
        payload.get("username") or char_name)

    # Current music track + whether a live audio stream is attachable right
    # now, so a late joiner's music widget starts in the correct state.
    now_playing = None
    try:
        if session.get("now_playing_json"):
            now_playing = dict(json.loads(session["now_playing_json"]),
                               active=audio_hub.is_active(session_id),
                               profile=audio_hub.profile(session_id))
    except (ValueError, TypeError):
        now_playing = None

    q = subscribe(session_id)
    await q.put({
        "type": "session_state",
        "data": {
            "tokens":     tokens,
            "characters": characters,
            "map_json":   session.get("map_json"),
            "rolls":      list(reversed(rolls)),
            "led":         led,
            "wled":        wled,
            "led_devices": led_devices,
            "now_playing": now_playing,
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
            mark_absent(session_id, payload["sub"])
            await publish(session_id, {
                "type": "player_offline",
                "data": {"player_name": char_name},
            })

    return EventSourceResponse(generator())
