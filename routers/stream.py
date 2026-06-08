import asyncio
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sse_starlette.sse import EventSourceResponse

import db
from auth import verify_player_token
from broadcast import publish, subscribe, unsubscribe

router = APIRouter()
_bearer = HTTPBearer(auto_error=False)

_PING_INTERVAL = 25  # seconds


@router.get("/session/{session_id}/stream")
async def stream(
    session_id: str,
    token: Optional[str] = None,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
):
    # Accept JWT from query-param (EventSource) or Authorization header
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

    tokens = await db.get_tokens_for_session(session_id)
    characters = await db.get_characters_for_session(session_id)

    q = subscribe(session_id)
    # Seed the queue with the current state so the client renders immediately
    await q.put({"type": "session_state", "data": {"tokens": tokens, "characters": characters}})

    async def generator():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=float(_PING_INTERVAL))
                    yield {"data": json.dumps(event)}
                except asyncio.TimeoutError:
                    yield {"data": json.dumps({"type": "ping", "data": {}})}
        except GeneratorExit:
            pass
        finally:
            unsubscribe(session_id, q)

    return EventSourceResponse(generator())
