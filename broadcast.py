import asyncio
from collections import defaultdict

# session_id -> list of per-client queues
_subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)


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
