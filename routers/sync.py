from fastapi import APIRouter, Header, HTTPException

import db
from auth import verify_gm_secret

router = APIRouter()


@router.get("/session/{session_id}/sync")
async def sync_session(session_id: str, x_relay_secret: str = Header(...)):
    if not verify_gm_secret(x_relay_secret):
        raise HTTPException(status_code=401, detail="Invalid relay secret")
    session = await db.get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    characters = await db.get_characters_for_session(session_id)
    tokens = await db.get_tokens_for_session(session_id)
    rolls = await db.get_rolls_for_session(session_id)
    pending_mutations = await db.get_pending_mutations(session_id)

    return {
        "session": session,
        "characters": characters,
        "tokens": tokens,
        "roll_log": rolls,
        "pending_mutations": pending_mutations,
    }
