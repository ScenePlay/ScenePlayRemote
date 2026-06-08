import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import db
from auth import verify_gm_secret, verify_player_token
from broadcast import publish
from models import TokenHealthRequest, TokenMoveRequest

router = APIRouter()
_bearer = HTTPBearer(auto_error=False)


async def _resolve_auth(
    x_relay_secret: Optional[str] = Header(default=None),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> dict:
    """Return {"role": "gm"} or {"role": "player", ...jwt_claims}."""
    if x_relay_secret is not None:
        if verify_gm_secret(x_relay_secret):
            return {"role": "gm"}
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    if credentials:
        try:
            payload = verify_player_token(credentials.credentials)
            return {"role": "player", **payload}
        except ValueError as exc:
            raise HTTPException(status_code=401, detail=str(exc))
    raise HTTPException(status_code=401, detail="Authentication required")


@router.post("/token/move")
async def move_token(request: TokenMoveRequest, caller: dict = Depends(_resolve_auth)):
    token = await db.get_token(request.token_id)

    if token is None:
        if caller["role"] != "gm":
            raise HTTPException(status_code=404, detail="Token not found")
        # GM is creating a new token
        if not request.session_id or not request.label:
            raise HTTPException(
                status_code=422,
                detail="session_id and label are required when creating a new token",
            )
        session = await db.get_session_by_id(request.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        await db.upsert_token(
            request.token_id,
            request.session_id,
            request.character_id,
            request.label,
            request.x_pct,
            request.y_pct,
            request.token_type,
        )
        token = await db.get_token(request.token_id)
    else:
        if caller["role"] == "player" and token["character_id"] != caller["sub"]:
            raise HTTPException(status_code=403, detail="Cannot move another player's token")
        await db.update_token_position(request.token_id, request.x_pct, request.y_pct)
        token = await db.get_token(request.token_id)

    await publish(token["session_id"], {
        "type": "token_move",
        "data": {
            "token_id": request.token_id,
            "label": token["label"],
            "x_pct": token["x_pct"],
            "y_pct": token["y_pct"],
        },
    })
    return {"ok": True}


@router.post("/token/health")
async def update_health(request: TokenHealthRequest, caller: dict = Depends(_resolve_auth)):
    token = await db.get_token(request.token_id)
    if not token:
        raise HTTPException(status_code=404, detail="Token not found")

    if caller["role"] == "player" and token["character_id"] != caller["sub"]:
        raise HTTPException(status_code=403, detail="Cannot update another player's health")

    character = None
    if token["character_id"]:
        character = await db.update_character_hp(
            token["character_id"], request.hp_current, request.hp_max
        )

    player_name = character["player_name"] if character else token["label"]
    await publish(token["session_id"], {
        "type": "health_update",
        "data": {
            "character_id": token["character_id"],
            "player_name": player_name,
            "hp_current": request.hp_current,
            "hp_max": request.hp_max,
        },
    })
    return {"ok": True}
