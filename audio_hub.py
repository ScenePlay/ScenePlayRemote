"""In-memory fan-out for the live music stream (binary sibling of broadcast.py).

Local ScenePlay pushes encoded MP3 chunks up in one long chunked POST per
capture period (rotated every few minutes to keep request durations bounded);
each listening browser holds a GET whose generator drains a bounded per-client
queue. Everything lives in process memory — same single-uvicorn-worker
constraint broadcast.py already has.
"""
import asyncio
import time
from collections import defaultdict, deque


class Superseded(Exception):
    """A newer ingest has taken over this session's stream."""


# ~12 s of audio at 128 kbps. Doubles as every listener's jitter buffer: a
# joiner receives this instantly and thereafter plays that far behind live,
# so POST rotations and wifi blips are absorbed instead of audible. Music
# doesn't need to be near-live; smooth beats fresh.
_PREROLL_BYTES = 192 * 1024

# One chunk ≈ 250 ms of audio, so 64 ≈ 16 s of headroom before a slow
# listener starts losing (oldest) audio.
_LISTENER_QUEUE = 64


class _SessionStream:
    def __init__(self) -> None:
        self.generation = 0
        self.active = False
        self.ended_at: float | None = None
        self.listeners: dict[int, asyncio.Queue] = {}
        self.preroll: deque[bytes] = deque()
        self.preroll_size = 0


_streams: dict[str, _SessionStream] = defaultdict(_SessionStream)


def begin(session_id: str, continuation: bool = False) -> int:
    """Start (or take over) the session's ingest; returns the new generation.

    A rotated POST (continuation=True) keeps the preroll — the encoder
    timeline is unbroken. A fresh capture clears it so late joiners don't
    hear the tail of the previous stream.
    """
    s = _streams[session_id]
    s.generation += 1
    s.active = True
    s.ended_at = None
    if not continuation:
        s.preroll.clear()
        s.preroll_size = 0
    return s.generation


def push(session_id: str, generation: int, chunk: bytes) -> None:
    s = _streams[session_id]
    if generation != s.generation:
        raise Superseded()
    if not chunk:
        return

    s.preroll.append(chunk)
    s.preroll_size += len(chunk)
    while s.preroll_size > _PREROLL_BYTES and len(s.preroll) > 1:
        s.preroll_size -= len(s.preroll.popleft())

    for q in list(s.listeners.values()):
        try:
            q.put_nowait(chunk)
        except asyncio.QueueFull:
            # Slow listener: drop its oldest ~250 ms; the MP3 decoder resyncs
            # on the next frame header. Ingest must never block on a client.
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                q.put_nowait(chunk)
            except asyncio.QueueFull:
                pass


def end(session_id: str, generation: int) -> None:
    s = _streams.get(session_id)
    if s and generation == s.generation:
        s.active = False
        s.ended_at = time.monotonic()


def is_active(session_id: str) -> bool:
    s = _streams.get(session_id)
    return bool(s and s.active)


def idle_seconds(session_id: str) -> float | None:
    """Seconds since the ingest ended, or None if active/never started."""
    s = _streams.get(session_id)
    if not s or s.active or s.ended_at is None:
        return None
    return time.monotonic() - s.ended_at


def listen(session_id: str) -> tuple[asyncio.Queue, bytes]:
    """Register a listener; returns (queue, preroll bytes for fast start)."""
    s = _streams[session_id]
    q: asyncio.Queue = asyncio.Queue(maxsize=_LISTENER_QUEUE)
    s.listeners[id(q)] = q
    return q, b"".join(s.preroll)


def unlisten(session_id: str, q: asyncio.Queue) -> None:
    s = _streams.get(session_id)
    if s:
        s.listeners.pop(id(q), None)
