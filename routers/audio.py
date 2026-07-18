"""Live music streaming: ingest from local ScenePlay, fan-out to browsers.

Local captures mpv's audio output, encodes it to MP3 with ffmpeg, and pushes
the bytes here as one long chunked POST (rotated every few minutes). Browsers
point an <audio> element at the GET endpoint — classic internet-radio shape.
The relay never stores audio; it only forwards live bytes (audio_hub).
"""
import asyncio
import json
import logging
import time
from typing import Optional

from fastapi import (APIRouter, Header, HTTPException, Request, WebSocket,
                     WebSocketDisconnect)
from fastapi.responses import StreamingResponse
from starlette.requests import ClientDisconnect

import audio_hub
import db
from auth import verify_gm_secret, verify_player_token
from broadcast import publish
from models import NowPlayingRequest

router = APIRouter()

# Stream lifecycle telemetry: one console line per ingest/listener connection
# open+close (never per chunk). Lands in Render's log viewer — the evidence
# for WHERE a drop happened (ingest leg vs a listener leg) after the fact.
log = logging.getLogger("uvicorn.error")

# How long a listener GET survives after the ingest stops before closing.
# Bridges POST rotation and inter-track gaps so browsers never reconnect
# mid-playlist; a real "stop" closes listeners this many seconds later.
_LISTENER_GRACE = 30


@router.post("/session/{session_id}/audio-ingest")
async def audio_ingest(
    session_id: str,
    request: Request,
    continuation: bool = False,
    x_relay_secret: str = Header(...),
    x_audio_profile: Optional[str] = Header(None),
):
    """Receive the live MP3 stream from local and fan it out to listeners."""
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    session = await db.get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    was_active = audio_hub.is_active(session_id)
    gen = audio_hub.begin(session_id, continuation=continuation,
                          profile=x_audio_profile)
    if not was_active:
        # profile rides along so the portal can size its live-edge lag
        # targets to match the relay's preroll
        await publish(session_id, {"type": "audio_state",
                                   "data": {"active": True,
                                            "profile": audio_hub.profile(session_id)}})

    log.info("audio ingest(post) begin session=%s gen=%s continuation=%s",
             session_id[:8], gen, continuation)
    total = 0
    started = time.monotonic()
    why = "eof"
    try:
        async for chunk in request.stream():
            audio_hub.push(session_id, gen, chunk)
            total += len(chunk)
    except audio_hub.Superseded:
        # A newer ingest took over (e.g. local restarted its push after a
        # network blip and the stale POST is still draining). end() is
        # generation-checked, so the finally below won't touch the new one.
        why = "superseded"
        return {"ok": False, "superseded": True, "bytes": total}
    except ClientDisconnect:
        why = "client-disconnect"
    finally:
        # No "active: false" publish here: POST rotation would flap it every
        # few minutes. The portal learns of a real stop from now_playing
        # (stream_active=false), and listener GETs close via the idle grace.
        audio_hub.end(session_id, gen)
        log.info("audio ingest(post) end session=%s gen=%s bytes=%s dur=%.0fs why=%s",
                 session_id[:8], gen, total, time.monotonic() - started, why)
    return {"ok": True, "bytes": total}


@router.websocket("/session/{session_id}/audio-ingest-ws")
async def audio_ingest_ws(websocket: WebSocket, session_id: str,
                          continuation: bool = False):
    """WebSocket ingest — the preferred transport. One persistent connection
    for the whole capture (no POST rotation, so no periodic stream gap);
    binary frames go straight into the same audio_hub fan-out. Auth and
    profile arrive as handshake headers, mirroring the POST path."""
    if not verify_gm_secret(websocket.headers.get("x-relay-secret", "")):
        await websocket.close(code=4401)
        return
    session = await db.get_session_by_id(session_id)
    if not session:
        await websocket.close(code=4404)
        return
    await websocket.accept()

    was_active = audio_hub.is_active(session_id)
    gen = audio_hub.begin(session_id, continuation=continuation,
                          profile=websocket.headers.get("x-audio-profile"))
    if not was_active:
        await publish(session_id, {"type": "audio_state",
                                   "data": {"active": True,
                                            "profile": audio_hub.profile(session_id)}})

    log.info("audio ingest(ws) begin session=%s gen=%s continuation=%s",
             session_id[:8], gen, continuation)
    total = 0
    started = time.monotonic()
    why = "closed"
    try:
        while True:
            chunk = await websocket.receive_bytes()
            audio_hub.push(session_id, gen, chunk)
            total += len(chunk)
    except WebSocketDisconnect:
        why = "client-disconnect"
    except audio_hub.Superseded:
        why = "superseded"
        try:
            await websocket.close(code=4409)
        except Exception:
            pass
    finally:
        audio_hub.end(session_id, gen)
        log.info("audio ingest(ws) end session=%s gen=%s bytes=%s dur=%.0fs why=%s",
                 session_id[:8], gen, total, time.monotonic() - started, why)


@router.get("/session/{session_id}/audio")
async def audio_listen(session_id: str, token: Optional[str] = None,
                       noreplay: bool = False):
    """Endless audio/mpeg response for the portal's <audio> element.

    JWT arrives as a query param because media elements can't set headers
    (same pattern as the SSE stream endpoint).
    """
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = verify_player_token(token)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc))
    if payload["session_id"] != session_id:
        raise HTTPException(status_code=403, detail="Token not valid for this session")

    session = await db.get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # noreplay=1 (reconnects) gets a small frame-aligned tail burst instead
    # of the full preroll — near the live edge, but never zero bytes (the
    # demuxer needs aligned probe data to start; see audio_hub._mp3_align).
    q, preroll = audio_hub.listen(session_id, reconnect=noreplay)

    player = payload.get("player_name", "?")
    log.info("listener attach session=%s player=%s noreplay=%s preroll=%sB",
             session_id[:8], player, noreplay, len(preroll))

    async def generator():
        sent = len(preroll)
        started = time.monotonic()
        why = "client-gone"
        try:
            if preroll:
                yield preroll
            while True:
                try:
                    chunk = await asyncio.wait_for(q.get(), timeout=5)
                except asyncio.TimeoutError:
                    idle = audio_hub.idle_seconds(session_id)
                    if idle is not None and idle > _LISTENER_GRACE:
                        why = "idle-grace"
                        break
                    continue
                if chunk is None:      # hub closed us: a NEW stream started;
                    why = "new-stream"
                    break              # the browser reconnects to that one
                sent += len(chunk)
                yield chunk
        finally:
            audio_hub.unlisten(session_id, q)
            log.info("listener close session=%s player=%s sent=%sB dur=%.0fs why=%s",
                     session_id[:8], player, sent, time.monotonic() - started, why)

    return StreamingResponse(
        generator(),
        media_type="audio/mpeg",
        # X-Accel-Buffering: nginx-convention hint (honored by several proxy
        # stacks) not to buffer this response — chunk coalescing in front of
        # a live stream adds lag and jitter.
        headers={"Cache-Control": "no-store", "Accept-Ranges": "none",
                 "X-Accel-Buffering": "no"},
    )


@router.post("/session/{session_id}/now-playing")
async def push_now_playing(
    session_id: str,
    request: NowPlayingRequest,
    x_relay_secret: str = Header(...),
):
    """Current track metadata from local — stored for late joiners and
    broadcast so the portal's music widget updates live."""
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    session = await db.get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    data = {
        "song_id":       request.song_id,
        "name":          request.name,
        "thumbnail":     request.thumbnail,
        "stream_active": request.stream_active,
    }
    await db.update_session_now_playing(session_id, json.dumps(data))
    await publish(session_id, {"type": "now_playing", "data": data})
    return {"ok": True}
