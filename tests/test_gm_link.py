"""gm_link channel semantics: attach/supersede generations, targeted emit,
close-on-lag with a guaranteed close sentinel."""
import gm_link


def _drain(conn):
    out = []
    while not conn.queue.empty():
        out.append(conn.queue.get_nowait())
    return out


def test_attach_supersede_detach():
    a = gm_link.attach("s1")
    assert gm_link.connected("s1")
    b = gm_link.attach("s1")                      # supersedes a
    assert a.superseded and not b.superseded
    assert _drain(a) == [None]                    # close sentinel for the old
    a_detach_before = gm_link.connected("s1")
    gm_link.detach("s1", a)                       # stale handler: no-op
    assert gm_link.connected("s1") == a_detach_before
    gm_link.detach("s1", b)
    assert not gm_link.connected("s1")


def test_emit_routes_to_current_conn_only():
    assert gm_link.emit("nope", {"type": "x"}) is None   # no GM — silent no-op
    a = gm_link.attach("s2")
    b = gm_link.attach("s2")
    gm_link.emit("s2", {"type": "ev"})
    assert _drain(b) == [{"type": "ev"}]
    assert _drain(a) == [None]                    # old conn got only its sentinel
    gm_link.detach("s2", b)


def test_emit_conn_skips_dead_connections():
    a = gm_link.attach("s3")
    a.superseded = True
    gm_link.emit_conn(a, {"type": "late-reply"})
    assert a.queue.empty()
    gm_link.detach("s3", a)


def test_close_on_lag_preserves_sentinel():
    a = gm_link.attach("s4")
    for i in range(gm_link._GM_QUEUE_MAX):
        gm_link.emit("s4", {"n": i})
    gm_link.emit("s4", {"n": "overflow"})         # full -> lagging + sentinel
    assert a.lagging
    items = _drain(a)
    assert items[-1] is None                      # sentinel delivered even when full
    gm_link.emit("s4", {"n": "after-death"})      # dropped silently
    assert a.queue.empty()
    gm_link.detach("s4", a)
