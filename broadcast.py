import asyncio
import time
from collections import defaultdict

# session_id -> list of per-client queues
_subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)

# Presence: session_id -> {sub: (player_name, last_seen_monotonic)}
_presence: dict[str, dict[str, tuple[str, float]]] = defaultdict(dict)


def subscribe(session_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subscribers[session_id].append(q)
    return q


def unsubscribe(session_id: str, q: asyncio.Queue) -> None:
    try:
        _subscribers[session_id].remove(q)
    except ValueError:
        pass


async def publish(session_id: str, event: dict) -> None:
    for q in list(_subscribers.get(session_id, [])):
        await q.put(event)


def mark_present(session_id: str, sub: str, player_name: str) -> None:
    """Record that a player is online right now."""
    _presence[session_id][sub] = (player_name, time.monotonic())


def mark_absent(session_id: str, sub: str) -> None:
    """Remove a player from the online set."""
    _presence[session_id].pop(sub, None)


def get_presence(session_id: str) -> dict[str, float]:
    """Return {player_name: seconds_since_last_seen} for the session."""
    now = time.monotonic()
    result = {}
    for _sub, (name, ts) in _presence.get(session_id, {}).items():
        result[name] = round(now - ts, 1)
    return result
