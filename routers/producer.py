"""Remote producer console — the portal side.

A DM login (JWT with `producer: true`) can open the console: it sees the
state document and frames local pushed (producer_hub) and STAGES commands
that local executes and acks. The relay never touches OBS or game state;
every row here is a request to the local box, not a decision.

Producer endpoints (producer JWT):
  POST   /producer/console/open        → {console_id}
  POST   /producer/console/ping        {console_id}
  DELETE /producer/console/{id}
  GET    /producer/state               → last state document (404 until pushed)
  GET    /producer/frame/{target}      → image/jpeg, 204 when none yet
  POST   /producer/command             → {id, status:'pending'}
GM endpoint (X-Relay-Secret):
  POST   /session/{id}/producer/ack    HTTP fallback for the socket ack
"""
import json
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import db
import gm_link
import producer_hub as hub
from auth import verify_gm_secret, verify_player_token
from broadcast import publish
from models import ProducerAckRequest, ProducerCommandRequest, ProducerConsoleRequest

log = logging.getLogger("uvicorn.error")
router = APIRouter()
_bearer = HTTPBearer()

COMMANDS = {
    'arm', 'take', 'spotlight', 'map_view', 'auto_cam_pause', 'activate_scene', 'skip',
    'kill', 'lights_off', 'music_toggle', 'set_volume', 'mute', 'fader', 'countdown',
    'marker', 'clock_reset', 'markers_clear', 'barge', 'producer_profile', 'transition',
}
TTL_DEFAULT_S = {'arm': 5.0, 'take': 5.0}
TTL_OTHER_S = 30.0
TTL_MAX_S = 60.0


def _get_producer(credentials: HTTPAuthorizationCredentials = Depends(_bearer)) -> dict:
    try:
        payload = verify_player_token(credentials.credentials)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc))
    if not payload.get("producer"):
        raise HTTPException(status_code=403, detail="Producer console is for DM logins")
    return payload


def _presence(session_id: str) -> None:
    gm_link.emit(session_id, {"type": "producer_presence",
                              "data": {"consoles": hub.console_count(session_id)}})


def presence_for_hello(session_id: str) -> int:
    return hub.console_count(session_id)


# ── consoles ─────────────────────────────────────────────────────────────────

@router.post("/producer/console/open")
async def console_open(producer: dict = Depends(_get_producer)):
    sid = producer["session_id"]
    cid = hub.open_console(sid)
    _presence(sid)
    return {"ok": True, "console_id": cid, "consoles": hub.console_count(sid),
            "linked": gm_link.connected(sid)}


@router.post("/producer/console/ping")
async def console_ping(request: ProducerConsoleRequest, producer: dict = Depends(_get_producer)):
    sid = producer["session_id"]
    ok = bool(request.console_id) and hub.ping_console(sid, request.console_id)
    return {"ok": ok, "consoles": hub.console_count(sid), "linked": gm_link.connected(sid)}


@router.delete("/producer/console/{console_id}")
async def console_close(console_id: str, producer: dict = Depends(_get_producer)):
    sid = producer["session_id"]
    hub.close_console(sid, console_id)
    _presence(sid)
    return {"ok": True, "consoles": hub.console_count(sid)}


# ── state and frames ─────────────────────────────────────────────────────────

@router.get("/producer/state")
async def producer_state(producer: dict = Depends(_get_producer)):
    sid = producer["session_id"]
    doc = hub.get_state(sid)
    if doc is None:
        raise HTTPException(status_code=404, detail="Local ScenePlay has not pushed the console yet")
    return {"state": doc, "age_s": hub.state_age(sid), "linked": gm_link.connected(sid)}


@router.get("/producer/frame/{target}")
async def producer_frame(target: str, producer: dict = Depends(_get_producer)):
    hit = hub.get_frame(producer["session_id"], target)
    headers = {"Cache-Control": "no-store"}
    if not hit:
        return Response(status_code=204, headers=headers)
    jpeg, ts = hit
    headers["X-Frame-Ts"] = str(ts)
    return Response(content=jpeg, media_type="image/jpeg", headers=headers)


# ── commands ─────────────────────────────────────────────────────────────────

@router.post("/producer/command")
async def producer_command(request: ProducerCommandRequest, producer: dict = Depends(_get_producer)):
    sid = producer["session_id"]
    cmd = (request.cmd or "").strip()
    if cmd not in COMMANDS:
        raise HTTPException(status_code=400, detail=f"Unknown command {cmd!r}")
    ttl = request.ttl_s if request.ttl_s and request.ttl_s > 0 else TTL_DEFAULT_S.get(cmd, TTL_OTHER_S)
    ttl = min(float(ttl), TTL_MAX_S)
    cid = await db.insert_producer_command(
        sid, producer.get("username") or producer.get("player_name") or "", cmd,
        json.dumps(request.args or {}), request.client_id, ttl)
    row = await db.get_producer_command(cid)
    gm_link.emit(sid, {"type": "producer_command", "data": row})
    return {"ok": True, "id": cid, "status": "pending", "linked": gm_link.connected(sid)}


async def core_ack(session_id: str, request: ProducerAckRequest) -> dict:
    """Shared by the socket (`producer_ack`) and the HTTP fallback."""
    row = await db.ack_producer_command(request.id, request.status, request.error)
    if row is None or row["session_id"] != session_id:
        return {"ok": False, "status": 404, "error": "no such command"}
    await publish(session_id, {"type": "producer_ack", "data": {
        "id": row["id"], "client_id": row.get("client_id"), "cmd": row["cmd"],
        "status": row["status"], "error": row.get("error") or ""}})
    return {"ok": True, "id": row["id"], "status": row["status"]}


@router.post("/session/{session_id}/producer/ack")
async def producer_ack(session_id: str, request: ProducerAckRequest,
                       x_relay_secret: str = Header(...)):
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    out = await core_ack(session_id, request)
    if not out.get("ok"):
        raise HTTPException(status_code=int(out.get("status") or 400), detail=out.get("error"))
    return out


# ── pushes from local (called by gm_ws._dispatch) ────────────────────────────

async def core_push_state(session_id: str, doc: dict) -> dict:
    if not isinstance(doc, dict):
        return {"ok": False, "status": 422, "error": "state must be an object"}
    hub.set_state(session_id, doc)
    await publish(session_id, {"type": "producer_state", "data": doc})
    return {"ok": True}


async def core_push_frame(session_id: str, payload: dict) -> dict:
    import base64
    target = str((payload or {}).get("target") or "")
    raw = (payload or {}).get("jpeg_b64") or ""
    if not target or not raw:
        return {"ok": False, "status": 422, "error": "target and jpeg_b64 required"}
    try:
        jpeg = base64.b64decode(raw)
    except Exception:
        return {"ok": False, "status": 422, "error": "bad base64"}
    ts = float((payload or {}).get("ts") or 0)
    hub.set_frame(session_id, target, jpeg, ts)
    await publish(session_id, {"type": "producer_frame_ts", "data": {"target": target, "ts": ts}})
    return {"ok": True}
