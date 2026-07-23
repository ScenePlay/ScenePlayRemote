import json

from fastapi import APIRouter, Header, HTTPException

import db
from auth import verify_gm_secret

router = APIRouter()


def _map_summary(raw_map):
    """Compact identity of the stored map for the GM box's 2 s sync poll.

    The receiver only needs the token ids (map-identity guard / stale-map
    resync) and the background URL (bg staleness check) — NOT the full
    map_json, whose tokens can embed base64 portraits (a single monster
    portrait made every poll ~250 KB; ~450 MB/hour). Shapes:
      None                          — no map stored on the relay
      {token_ids: None, url: ''}    — stored map_json unparseable
      {token_ids: [...], url: str}  — normal
    """
    if not raw_map:
        return None
    try:
        mp = json.loads(raw_map)
        return {
            "token_ids": [t.get("token_id") for t in (mp.get("tokens") or [])
                          if t.get("token_id") is not None],
            "url": mp.get("url") or "",
        }
    except (ValueError, TypeError, AttributeError):
        return {"token_ids": None, "url": ""}


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

    # Strip the bulky blobs the receiver never reads from this poll; portal
    # joiners still get the full map/scene via the SSE session_state snapshot.
    session = dict(session)
    session["map_summary"] = _map_summary(session.pop("map_json", None))
    session.pop("scene_json", None)

    return {
        "session": session,
        "characters": characters,
        "tokens": tokens,
        "roll_log": rolls,
        "pending_mutations": pending_mutations,
    }
