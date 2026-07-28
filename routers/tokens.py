import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import db
import gm_link
from auth import verify_gm_secret, verify_player_token
from broadcast import publish
from models import TokenHealthRequest, TokenMoveRequest


async def _player_owns_token_label(label: str, session_id: str, username: str) -> bool:
    """True if any character in the session with this username has the given player_name == label."""
    chars = await db.get_characters_by_username(session_id, username)
    return any(c.get("player_name") == label for c in chars)

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
    return await apply_token_move(request, caller)


async def apply_token_move(request: TokenMoveRequest, caller: dict) -> dict:
    """Shared core for the REST route and the GM WebSocket dispatcher — one
    body so the two transports can't drift. Player-origin moves are emitted
    to the GM link (GM-origin ones are not: that's the echo filter)."""
    token = await db.get_token(request.token_id)

    if token is None:
        if caller["role"] == "gm":
            # GM creating a new token
            if not request.session_id or not request.label:
                raise HTTPException(
                    status_code=422,
                    detail="session_id and label are required when creating a new token",
                )
            session = await db.get_session_by_id(request.session_id)
            if not session:
                raise HTTPException(status_code=404, detail="Session not found")
        else:
            # Player moving their own token for the first time (not yet in relay DB).
            # Resolve session from JWT and verify ownership by label.
            session_id = caller.get("session_id")
            label = request.label or ""
            if not label or not await _player_owns_token_label(label, session_id, caller.get("username", "")):
                raise HTTPException(status_code=403, detail="Cannot move another player's token")
            request.session_id = request.session_id or session_id
            request.label      = request.label or label
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
        if caller["role"] == "player":
            # Allow if JWT sub matches stored character_id (relay UUID match)
            # OR the token's label belongs to one of the caller's characters.
            owns = (token["character_id"] == caller["sub"]) or await _player_owns_token_label(
                token.get("label", ""), token["session_id"], caller.get("username", "")
            )
            if not owns:
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
            "token_type": token["token_type"],
            "character_id": token["character_id"],
        },
    })
    if caller["role"] == "player":
        # full row incl. the seq stamped by this very update, so the GM box
        # applies it through the same watermark logic the /sync poll used
        gm_link.emit(token["session_id"], {"type": "token_move",
                                           "data": dict(token)})
    return {"ok": True}


@router.post("/token/health")
async def update_health(request: TokenHealthRequest, caller: dict = Depends(_resolve_auth)):
    return await apply_token_health(request, caller)


async def apply_token_health(request: TokenHealthRequest, caller: dict) -> dict:
    """Shared core for REST + GM WebSocket (see apply_token_move)."""
    token = await db.get_token(request.token_id)

    if token is None:
        # Monster tokens (and any token not yet moved) aren't in token_positions.
        # GMs may still push health updates; broadcast directly using the provided session_id.
        if caller["role"] != "gm":
            raise HTTPException(status_code=404, detail="Token not found")
        session_id = request.session_id
        if not session_id:
            raise HTTPException(status_code=422, detail="session_id required for unknown token")
    else:
        session_id = token["session_id"]
        if caller["role"] == "player":
            owns = (token["character_id"] == caller["sub"]) or await _player_owns_token_label(
                token.get("label", ""), session_id, caller.get("username", "")
            )
            if not owns:
                raise HTTPException(status_code=403, detail="Cannot update another player's health")
        if token["character_id"]:
            await db.update_character_hp(
                token["character_id"], request.hp_current, request.hp_max
            )

    await publish(session_id, {
        "type": "health_update",
        "data": {
            "token_id": request.token_id,
            "hp_current": request.hp_current,
            "hp_max": request.hp_max,
        },
    })
    if caller["role"] == "player":
        gm_link.emit(session_id, {"type": "health_update",
                                  "data": {"token_id": request.token_id,
                                           "hp_current": request.hp_current,
                                           "hp_max": request.hp_max}})
    return {"ok": True}
