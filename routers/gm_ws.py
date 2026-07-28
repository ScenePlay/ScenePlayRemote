"""GM control WebSocket — the persistent link to the ScenePlay box.

`WS /api/v1/session/{session_id}/gm-ws`, authenticated with the X-Relay-Secret
handshake header (the audio-ingest-ws pattern: close 4401/4404 before accept,
4409 when a newer GM connection supersedes this one).

Wire protocol (JSON text frames):
  GM -> relay:  {"id"?: int, "type": str, "payload": {...}}
                Replies {"id": int, "ok": bool, ...} are sent when "id" is
                present. A bad message answers ok:false with "status"
                mirroring the REST status code — it never kills the socket.
  relay -> GM:  {"type": str, "data": {...}} events:
                hello (connect replay), mutation, token_move, health_update,
                roll_result, presence_change, presence (~10s snapshot),
                sync_hint (~60s: map_summary + tokens + latest_roll_id, which
                feeds the GM box's stale-map self-heal watchdog).

All outgoing traffic (events AND replies) funnels through the gm_link queue so
exactly one task touches websocket.send_json.
"""
import asyncio
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from pydantic import ValidationError

import db
import gm_link
from auth import verify_gm_secret
from broadcast import get_presence
from models import (ConditionUpdateRequest, LedPushRequest, MutationAckRequest,
                    TokenHealthRequest, TokenMoveRequest, WledPushRequest)
from routers import gm as gm_routes
from routers import tokens as token_routes
from routers.gm import PushRollRequest
from routers.sync import _map_summary

log = logging.getLogger("uvicorn.error")

router = APIRouter()

_PRESENCE_EVERY_S = 10.0
_SYNC_HINT_EVERY_S = 60.0


async def _build_hello(session_id: str) -> dict:
    session = await db.get_session_by_id(session_id)
    rolls = await db.get_rolls_for_session(session_id, limit=50)
    return {
        "pending_mutations": await db.get_pending_mutations(session_id),
        "tokens": await db.get_tokens_for_session(session_id),
        "presence": get_presence(session_id),
        "map_summary": _map_summary((session or {}).get("map_json")),
        "roll_log": rolls,
        "latest_roll_id": max((r["id"] for r in rolls), default=0),
    }


async def _build_sync_hint(session_id: str) -> dict:
    session = await db.get_session_by_id(session_id)
    rolls = await db.get_rolls_for_session(session_id, limit=1)
    return {
        "map_summary": _map_summary((session or {}).get("map_json")),
        "tokens": await db.get_tokens_for_session(session_id),
        "latest_roll_id": max((r["id"] for r in rolls), default=0),
    }


async def _dispatch(session_id: str, msg: dict) -> dict:
    """Handle one GM request; returns the reply dict (without id)."""
    mtype = msg.get("type")
    payload = msg.get("payload") or {}
    caller = {"role": "gm"}
    try:
        if mtype == "token_move":
            return await token_routes.apply_token_move(
                TokenMoveRequest(**payload), caller)
        if mtype == "token_health":
            return await token_routes.apply_token_health(
                TokenHealthRequest(**payload), caller)
        if mtype == "condition_update":
            return await gm_routes.core_condition_update(
                session_id, ConditionUpdateRequest(**payload))
        if mtype == "roll":
            return await gm_routes.core_push_roll(
                session_id, PushRollRequest(**payload))
        if mtype == "led":
            return await gm_routes.core_push_led(
                session_id, LedPushRequest(**payload))
        if mtype == "wled":
            return await gm_routes.core_push_wled(
                session_id, WledPushRequest(**payload))
        if mtype == "ack_mutations":
            return await gm_routes.core_ack_mutations(
                MutationAckRequest(**payload))
        if mtype == "presence_get":
            return {"ok": True, "presence": get_presence(session_id)}
        if mtype == "rolls_get":
            rolls = await db.get_rolls_since(
                session_id, int(payload.get("since_id") or 0))
            return {"ok": True, "rolls": rolls}
        return {"ok": False, "status": 400, "error": "unknown_type"}
    except HTTPException as exc:
        return {"ok": False, "status": exc.status_code, "error": str(exc.detail)}
    except ValidationError as exc:
        return {"ok": False, "status": 422, "error": str(exc)[:300]}
    except Exception as exc:                      # one bad message must not
        log.warning("gm-ws %s handler error: %s", mtype, exc)   # kill the link
        return {"ok": False, "status": 500, "error": str(exc)[:300]}


async def _send_loop(websocket: WebSocket, conn: gm_link.GmConn, session_id: str):
    """Sole sender: drains the gm_link queue and runs the periodic timers."""
    last_presence = time.monotonic()
    last_hint = time.monotonic()
    while True:
        try:
            item = await asyncio.wait_for(conn.queue.get(), timeout=2.0)
        except asyncio.TimeoutError:
            item = "__tick__"
        if item is None:                          # superseded or lagging
            code = 4409 if conn.superseded else 1011
            try:
                await websocket.close(code=code)
            except Exception:
                pass
            return
        if item != "__tick__":
            await websocket.send_json(item)
        now = time.monotonic()
        if now - last_presence >= _PRESENCE_EVERY_S:
            last_presence = now
            await websocket.send_json({"type": "presence",
                                       "data": get_presence(session_id)})
        if now - last_hint >= _SYNC_HINT_EVERY_S:
            last_hint = now
            await websocket.send_json({"type": "sync_hint",
                                       "data": await _build_sync_hint(session_id)})


@router.websocket("/session/{session_id}/gm-ws")
async def gm_ws(websocket: WebSocket, session_id: str):
    if not verify_gm_secret(websocket.headers.get("x-relay-secret", "")):
        await websocket.close(code=4401)
        return
    session = await db.get_session_by_id(session_id)
    if not session:
        await websocket.close(code=4404)
        return
    await websocket.accept()

    conn = gm_link.attach(session_id)
    log.info("gm-ws attach session=%s gen=%s", session_id[:8], conn.gen)
    send_task = None
    why = "closed"
    try:
        await websocket.send_json({"type": "hello",
                                   "data": await _build_hello(session_id)})
        send_task = asyncio.create_task(_send_loop(websocket, conn, session_id))
        while True:
            msg = await websocket.receive_json()
            reply = await _dispatch(session_id, msg)
            if msg.get("id") is not None:
                reply["id"] = msg["id"]
                gm_link.emit_conn(conn, reply)    # via the queue: single sender
            if send_task.done():                  # sender died (close/supersede)
                break
    except WebSocketDisconnect:
        why = "client-disconnect"
    except Exception as exc:
        why = f"error: {exc}"
    finally:
        if send_task is not None:
            send_task.cancel()
        gm_link.detach(session_id, conn)
        log.info("gm-ws detach session=%s gen=%s why=%s",
                 session_id[:8], conn.gen, why)
