import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import db
from auth import issue_player_token, verify_player_token
from broadcast import publish
from models import CharacterRequest, JoinRequest, JoinResponse, RollRequest

router = APIRouter()
_bearer = HTTPBearer()


def _get_player(credentials: HTTPAuthorizationCredentials = Depends(_bearer)) -> dict:
    try:
        return verify_player_token(credentials.credentials)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc))


@router.post("/join", response_model=JoinResponse)
async def join(request: JoinRequest):
    session = await db.get_session_by_code(request.code.upper().strip())
    if not session:
        raise HTTPException(status_code=404, detail="Invalid join code")
    player_id = str(uuid.uuid4())
    token = issue_player_token(player_id, request.name.strip(), session["id"])
    return JoinResponse(token=token)


@router.post("/character")
async def save_character(request: CharacterRequest, player: dict = Depends(_get_player)):
    sheet_str = json.dumps(request.sheet)
    await db.upsert_character(
        player["sub"],
        player["session_id"],
        player["player_name"],
        sheet_str,
        request.hp_current,
        request.hp_max,
    )

    # Auto-create a player token the first time a character is saved
    existing = await db.get_token_by_character(player["sub"])
    if not existing:
        token_id = str(uuid.uuid4())
        await db.upsert_token(
            token_id,
            player["session_id"],
            player["sub"],
            player["player_name"],
            50.0,
            50.0,
            "player",
        )

    await publish(player["session_id"], {
        "type": "character_saved",
        "data": {"player_id": player["sub"], "player_name": player["player_name"]},
    })
    return {"ok": True}


@router.post("/roll")
async def submit_roll(request: RollRequest, player: dict = Depends(_get_player)):
    await db.insert_roll(
        player["session_id"],
        player["player_name"],
        request.roll_expr,
        request.result,
        request.breakdown,
    )
    await publish(player["session_id"], {
        "type": "roll_result",
        "data": {
            "player": player["player_name"],
            "roll": request.roll_expr,
            "result": request.result,
            "breakdown": request.breakdown,
        },
    })
    return {"ok": True}
