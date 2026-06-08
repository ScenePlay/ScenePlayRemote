import json
import random
import string
import uuid

from fastapi import APIRouter, Header, HTTPException

import db
from auth import verify_gm_secret
from broadcast import publish
from models import GenerateCodeResponse, PushRequest

router = APIRouter()


def _random_code(length: int = 6) -> str:
    chars = string.ascii_uppercase + string.digits
    return "".join(random.choices(chars, k=length))


@router.post("/session/generate-code", response_model=GenerateCodeResponse)
async def generate_code(x_relay_secret: str = Header(...)):
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
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
    map_str = json.dumps(request.map) if request.map is not None else None
    await db.update_session_state(request.session_id, scene_str, map_str)

    if request.scene is not None:
        await publish(request.session_id, {"type": "scene_update", "data": request.scene})
    if request.map is not None:
        await publish(request.session_id, {"type": "map_update", "data": request.map})

    return {"ok": True}
