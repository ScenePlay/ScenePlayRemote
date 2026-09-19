"""In-memory cache for the remote producer console (sibling of audio_hub).

Local ScenePlay pushes the console's state document and JPEG frames up the
GM WebSocket; this module keeps only the LATEST of each per session, and the
set of open producer consoles (portal tabs), so local knows whether to keep
pushing frames. Nothing here is authoritative and nothing is persisted:
a restart simply waits for the next push. Single uvicorn worker, single
event loop — plain dicts, no locks.
"""
import time
import uuid

CONSOLE_TTL_S = 45.0          # a console that has not pinged in this long is gone

_state: dict[str, dict] = {}                     # session_id -> state document
_state_at: dict[str, float] = {}                 # session_id -> monotonic
_frames: dict[str, dict[str, tuple[bytes, float]]] = {}   # session -> target -> (jpeg, ts)
_consoles: dict[str, dict[str, float]] = {}      # session -> console_id -> last ping


# ── state ────────────────────────────────────────────────────────────────────

def set_state(session_id: str, doc: dict) -> None:
    _state[session_id] = doc
    _state_at[session_id] = time.monotonic()


def get_state(session_id: str) -> dict | None:
    return _state.get(session_id)


def state_age(session_id: str) -> float | None:
    at = _state_at.get(session_id)
    return None if at is None else time.monotonic() - at


# ── frames ───────────────────────────────────────────────────────────────────

def set_frame(session_id: str, target: str, jpeg: bytes, ts: float) -> None:
    _frames.setdefault(session_id, {})[target] = (jpeg, ts)


def get_frame(session_id: str, target: str) -> tuple[bytes, float] | None:
    return _frames.get(session_id, {}).get(target)


# ── consoles ─────────────────────────────────────────────────────────────────

def _reap(session_id: str) -> None:
    now = time.monotonic()
    live = _consoles.get(session_id)
    if not live:
        return
    for cid in [c for c, at in live.items() if now - at > CONSOLE_TTL_S]:
        del live[cid]


def open_console(session_id: str) -> str:
    cid = uuid.uuid4().hex[:12]
    _consoles.setdefault(session_id, {})[cid] = time.monotonic()
    return cid


def ping_console(session_id: str, cid: str) -> bool:
    live = _consoles.get(session_id, {})
    if cid in live:
        live[cid] = time.monotonic()
        return True
    return False


def close_console(session_id: str, cid: str) -> None:
    _consoles.get(session_id, {}).pop(cid, None)


def console_count(session_id: str) -> int:
    _reap(session_id)
    return len(_consoles.get(session_id, {}))


def purge(session_id: str | None = None) -> None:
    """Forget a session (or everything) — session/create purges the old one."""
    if session_id is None:
        _state.clear(); _state_at.clear(); _frames.clear(); _consoles.clear()
        return
    for d in (_state, _state_at, _frames, _consoles):
        d.pop(session_id, None)
