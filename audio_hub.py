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


# Preroll per latency profile. Every joiner receives the preroll instantly
# and thereafter plays that far behind live, so it IS the stream's baseline
# delay — the dominant share of what listeners perceive as lag.
#   'low'    ~4 s @128k — near-live table experience with just enough armor
#            to absorb an ingest-POST rotation blip or a short wifi stumble.
#   'smooth' ~12 s @128k — the original behavior; smooth beats fresh.
# The GM picks per-box (relay_audio_profile app setting); local forwards it
# as X-Audio-Profile on each ingest POST. Absent header (older local
# versions) keeps the original 'smooth' behavior.
_PREROLL_PROFILES = {"low": 64 * 1024, "smooth": 192 * 1024}
_DEFAULT_PROFILE = "smooth"

# Per-listener queue depth. Local batches writes to ~4 KB (~250 ms), so 512
# slots ≈ 2 MB ≈ 2 minutes of headroom per listener — RAM is the relay's
# cheapest resource. A listener that falls even further behind is CLOSED
# cleanly (see push) rather than having middle bytes dropped: byte-splicing
# a live MP3 stream was audible corruption ("missed bytes"), while a close
# makes the portal reconnect at the live edge with a fresh aligned burst.
_LISTENER_QUEUE = 512


class _SessionStream:
    def __init__(self) -> None:
        self.generation = 0
        self.active = False
        self.ended_at: float | None = None
        self.listeners: dict[int, asyncio.Queue] = {}
        self.preroll: deque[bytes] = deque()
        self.preroll_size = 0
        self.profile = _DEFAULT_PROFILE


_streams: dict[str, _SessionStream] = defaultdict(_SessionStream)


def begin(session_id: str, continuation: bool = False,
          profile: str | None = None) -> int:
    """Start (or take over) the session's ingest; returns the new generation.

    A rotated POST (continuation=True) keeps the preroll — the encoder
    timeline is unbroken. A fresh capture clears it so late joiners don't
    hear the tail of the previous stream. An unknown/absent profile keeps
    the session's current one.
    """
    s = _streams[session_id]
    s.generation += 1
    s.active = True
    s.ended_at = None
    if profile in _PREROLL_PROFILES:
        s.profile = profile
    if not continuation:
        s.preroll.clear()
        s.preroll_size = 0
        # A fresh capture is a NEW mp3 timeline. Listeners still attached to
        # the old one would stall on the discontinuity (their element's clock
        # belongs to the previous stream) — close them with a sentinel so
        # browsers reconnect cleanly and get the new preroll instead.
        for q in list(s.listeners.values()):
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait(None)
                except asyncio.QueueFull:
                    pass
    return s.generation


def push(session_id: str, generation: int, chunk: bytes) -> None:
    s = _streams[session_id]
    if generation != s.generation:
        raise Superseded()
    if not chunk:
        return

    s.preroll.append(chunk)
    s.preroll_size += len(chunk)
    cap = _PREROLL_PROFILES[s.profile]
    while s.preroll_size > cap and len(s.preroll) > 1:
        s.preroll_size -= len(s.preroll.popleft())

    for q in list(s.listeners.values()):
        try:
            q.put_nowait(chunk)
        except asyncio.QueueFull:
            # Hopelessly-behind listener (2+ minutes): close it with the
            # sentinel instead of splicing bytes out of its stream. Ingest
            # never blocks on a client; the portal reconnects at the live
            # edge with a fresh frame-aligned burst.
            s.listeners.pop(id(q), None)
            try:
                while True:
                    q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                q.put_nowait(None)
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


def profile(session_id: str) -> str:
    """The session's latency profile ('low' | 'smooth') — the portal reads it
    (via SSE) to size its own live-edge lag targets to match the preroll."""
    s = _streams.get(session_id)
    return s.profile if s else _DEFAULT_PROFILE


def idle_seconds(session_id: str) -> float | None:
    """Seconds since the ingest ended, or None if active/never started."""
    s = _streams.get(session_id)
    if not s or s.active or s.ended_at is None:
        return None
    return time.monotonic() - s.ended_at


def _mp3_align(data: bytes) -> bytes:
    """Slice to the first plausible MPEG frame header.

    Preroll chunks are arbitrary 4 KB slices, so a mid-stream joiner would
    otherwise start mid-frame: Chrome's demuxer probes those garbage bytes,
    misparses the frame grid and aborts with a decode error a few seconds in
    (the classic icecast burst-alignment problem — real icecast frame-aligns
    its burst-on-connect for exactly this reason)."""
    for i in range(len(data) - 4):
        if (data[i] == 0xFF and (data[i + 1] & 0xE0) == 0xE0
                and (data[i + 1] & 0x18) != 0x08      # version not reserved
                and (data[i + 1] & 0x06) != 0x00):    # layer not reserved
            return data[i:]
    return data


# Reconnect burst: enough aligned bytes to probe and start immediately,
# small enough that the replay of already-heard audio is barely perceptible
# (~0.75 s @128k). Larger bursts made every hiccup-recovery audibly repeat
# the same block — and a flaky stretch repeated it on each retry.
_RECONNECT_BURST = 12 * 1024


def listen(session_id: str, reconnect: bool = False) -> tuple[asyncio.Queue, bytes]:
    """Register a listener; returns (queue, frame-aligned burst bytes).

    Fresh joiners get the full preroll (fast start + jitter cushion).
    Reconnects get a small tail burst instead — resuming near the live edge
    without a long replay, but never zero bytes: an empty start would leave
    the browser waiting multiple seconds for probe data, and its first live
    chunk would be mid-frame anyway. The burst snapshot is taken BEFORE the
    queue is registered so a chunk pushed during attach can't appear in both.
    """
    s = _streams[session_id]
    burst = b"".join(s.preroll)
    if reconnect and len(burst) > _RECONNECT_BURST:
        burst = burst[-_RECONNECT_BURST:]
    q: asyncio.Queue = asyncio.Queue(maxsize=_LISTENER_QUEUE)
    s.listeners[id(q)] = q
    return q, _mp3_align(burst)


def unlisten(session_id: str, q: asyncio.Queue) -> None:
    s = _streams.get(session_id)
    if s:
        s.listeners.pop(id(q), None)
