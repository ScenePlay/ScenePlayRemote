"""GM control-link channel: the relay side of the persistent GM WebSocket.

Deliberately NOT a broadcast.py subscriber — the GM socket must never hear
the GM's own pushes echoed back, so events reach it only through explicit
gm_link.emit() hooks at player-origin call sites (mutations, player token
moves, player rolls, presence changes).

One GM connection per session; a new connection supersedes the old (the
audio_hub generation idiom): the old handler drains a None sentinel and
closes with 4409. The outgoing queue is bounded — on overflow the connection
is marked lagging and closed, and the Flask side's reconnect `hello` replay
restores anything that was lost, so overflow is self-healing.

Single uvicorn worker + single event loop (same constraint as broadcast.py /
audio_hub.py); all callers are async handlers, so plain dicts need no locks.
"""
import asyncio
import itertools

_GM_QUEUE_MAX = 512

_conns: dict = {}                 # session_id -> GmConn
_gen = itertools.count(1)


class GmConn:
    def __init__(self, session_id: str, gen: int):
        self.session_id = session_id
        self.gen = gen
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=_GM_QUEUE_MAX)
        self.superseded = False
        self.lagging = False


def attach(session_id: str) -> GmConn:
    """Register the (single) GM connection for a session, superseding any old one."""
    old = _conns.get(session_id)
    if old is not None:
        old.superseded = True
        _push_sentinel(old)
    conn = GmConn(session_id, next(_gen))
    _conns[session_id] = conn
    return conn


def detach(session_id: str, conn: GmConn) -> None:
    """Generation-checked: a stale handler can't detach its successor."""
    if _conns.get(session_id) is conn:
        del _conns[session_id]


def connected(session_id: str) -> bool:
    return session_id in _conns


def emit(session_id: str, event: dict) -> None:
    """Queue an event for the session's CURRENT GM socket. No-op when no GM
    is attached. On a full queue the connection is closed (close-on-lag)
    rather than blocking the caller or growing without bound."""
    conn = _conns.get(session_id)
    if conn is not None:
        emit_conn(conn, event)


def emit_conn(conn: GmConn, event: dict) -> None:
    """Queue an event for a SPECIFIC connection — used for request replies so
    a superseded handler can't leak stale replies into its successor."""
    if conn.lagging or conn.superseded:
        return
    try:
        conn.queue.put_nowait(event)
    except asyncio.QueueFull:
        conn.lagging = True
        _push_sentinel(conn)


def _push_sentinel(conn: GmConn) -> None:
    """Deliver the None close sentinel even when the queue is full."""
    try:
        conn.queue.put_nowait(None)
    except asyncio.QueueFull:
        try:
            conn.queue.get_nowait()       # make room — content loss is fine,
        except asyncio.QueueEmpty:        # the reconnect hello replays state
            pass
        try:
            conn.queue.put_nowait(None)
        except asyncio.QueueFull:
            pass
