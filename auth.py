import hmac
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt

from config import JWT_SECRET, RELAY_SECRET

_ALGORITHM = "HS256"
_TOKEN_EXPIRY_HOURS = 12


def verify_gm_secret(secret: str) -> bool:
    return hmac.compare_digest(secret.encode(), RELAY_SECRET.encode())


def issue_player_token(sub: str, player_name: str, session_id: str) -> str:
    payload = {
        "sub": sub,
        "player_name": player_name,
        "session_id": session_id,
        "scope": "player",
        "exp": datetime.now(timezone.utc) + timedelta(hours=_TOKEN_EXPIRY_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=_ALGORITHM)


def verify_player_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[_ALGORITHM])
    except JWTError as exc:
        raise ValueError("invalid token") from exc
    if payload.get("scope") != "player":
        raise ValueError("wrong scope")
    return payload
