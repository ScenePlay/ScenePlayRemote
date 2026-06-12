import logging

import httpx

from config import RELAY_SECRET, SCENEPLAY_URL

log = logging.getLogger(__name__)

_TIMEOUT = 10.0
_AUTH_PATH = "/ttrpg/relay/api/auth/verify"
_INFO_PATH = "/ttrpg/relay/api/session/info"


def _headers() -> dict:
    return {"X-Relay-Secret": RELAY_SECRET}


async def verify_player(username: str, password: str) -> dict:
    """
    Call ScenePlay auth. Returns the full response dict on success.
    Raises ValueError with a user-facing message on failure.
    Raises RuntimeError if SCENEPLAY_URL is not configured.
    """
    if not SCENEPLAY_URL:
        raise RuntimeError("SCENEPLAY_URL is not configured")
    async with httpx.AsyncClient() as client:
        try:
            r = await client.post(
                f"{SCENEPLAY_URL}{_AUTH_PATH}",
                json={"username": username, "password": password},
                headers=_headers(),
                timeout=_TIMEOUT,
            )
        except httpx.TransportError as exc:
            raise RuntimeError(f"Auth service unreachable: {exc}") from exc

    # 4xx from ScenePlay means bad credentials, not a service failure
    data = r.json()
    if not data.get("ok") or r.status_code >= 400:
        raise ValueError(data.get("error", "Invalid username or password"))
    return data


async def fetch_session_info() -> dict | None:
    """
    Fetch active session info from ScenePlay on startup.
    Returns None (and logs a warning) if unavailable.
    """
    if not SCENEPLAY_URL:
        log.warning("SCENEPLAY_URL not set — skipping session bootstrap")
        return None
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{SCENEPLAY_URL}{_INFO_PATH}",
                headers=_headers(),
                timeout=_TIMEOUT,
            )
            r.raise_for_status()
            return r.json()
    except Exception as exc:
        log.warning("Could not reach ScenePlay for session bootstrap: %s", exc)
        return None
