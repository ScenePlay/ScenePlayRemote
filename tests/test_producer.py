"""Remote producer console: DM role on the users push, the producer flag on
join, producer-only endpoints, the staged command round trip over the GM
socket (stage → emit → ack → SSE ack), state/frame caches, hello and sync
replay, and the SSE visibility rule."""
import base64
import json

import bcrypt
import pytest

from tests.conftest import GM_HEADERS

WS_PATH = "/api/v1/session/{sid}/gm-ws"
PW = "pw"
HASH = bcrypt.hashpw(PW.encode(), bcrypt.gensalt()).decode()


def _push_users(client, sid, *users):
    r = client.post(f"/api/v1/session/{sid}/users", headers=GM_HEADERS,
                    json={"users": [dict(username=u, display_name=u.title(), password_hash=HASH, **kw)
                                    for u, kw in users]})
    assert r.status_code == 200, r.text


def _code(client, sid):
    r = client.get(f"/api/v1/session/{sid}/sync", headers=GM_HEADERS)
    return r.json()["session"]["code"]


def _join(client, sid, name):
    r = client.post("/api/v1/join", json={"name": name, "password": PW, "code": _code(client, sid)})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _claims(token):
    body = token.split(".")[1]
    body += "=" * (-len(body) % 4)
    return json.loads(base64.urlsafe_b64decode(body))


def _recv_until(ws, mtype, limit=30):
    for _ in range(limit):
        f = ws.receive_json()
        if f.get("type") == mtype:
            return f
    raise AssertionError(f"no {mtype} frame")


@pytest.fixture()
def accounts(client, session_id):
    from routers import player as _player
    _player._join_attempts.clear()          # the per-IP join limiter is per process
    _push_users(client, session_id, ("gm", {"role": "dm"}), ("pl", {"role": "player"}), ("old", {}))
    return session_id


# ── role + join ──────────────────────────────────────────────────────────────

def test_users_push_stores_role_and_defaults_player(client, accounts):
    dm = _claims(_join(client, accounts, "gm"))
    pl = _claims(_join(client, accounts, "pl"))
    old = _claims(_join(client, accounts, "old"))
    assert dm.get("producer") is True and dm["scope"] == "player"
    assert "producer" not in pl and "producer" not in old


def test_role_survives_a_push_without_role(client, accounts):
    _push_users(client, accounts, ("gm", {}))          # an older local re-pushes
    assert _claims(_join(client, accounts, "gm")).get("producer") is True


def test_dm_with_character_also_gets_flag(client, accounts):
    r = client.post(f"/api/v1/session/{accounts}/characters", headers=GM_HEADERS, json={"characters": [
        {"player_name": "Kaz", "username": "gm", "password_hash": HASH, "sheet_json": "{}", "hp_current": 5, "hp_max": 5}]})
    assert r.status_code == 200, r.text
    tok = _join(client, accounts, "gm")
    assert _claims(tok).get("producer") is True and _claims(tok)["sub"] != "user:gm"


# ── producer-only endpoints ──────────────────────────────────────────────────

def test_player_token_is_refused(client, accounts):
    h = {"Authorization": f"Bearer {_join(client, accounts, 'pl')}"}
    assert client.get("/api/v1/producer/state", headers=h).status_code == 403
    assert client.post("/api/v1/producer/command", headers=h, json={"cmd": "take"}).status_code == 403
    assert client.post("/api/v1/producer/console/open", headers=h, json={}).status_code == 403


def test_state_404_until_pushed_then_served(client, accounts):
    h = {"Authorization": f"Bearer {_join(client, accounts, 'gm')}"}
    assert client.get("/api/v1/producer/state", headers=h).status_code == 404
    with client.websocket_connect(WS_PATH.format(sid=accounts), headers=GM_HEADERS) as ws:
        ws.receive_json()                                            # hello
        ws.send_json({"type": "producer_state", "payload": {"program": "Party", "shots": []}})
        ws.send_json({"id": 1, "type": "presence_get", "payload": {}})   # ordering fence
        for _ in range(10):
            f = ws.receive_json()
            if f.get("id") == 1:
                break
    r = client.get("/api/v1/producer/state", headers=h)
    assert r.status_code == 200 and r.json()["state"]["program"] == "Party"


def test_frame_cache(client, accounts):
    h = {"Authorization": f"Bearer {_join(client, accounts, 'gm')}"}
    assert client.get("/api/v1/producer/frame/program", headers=h).status_code == 204
    with client.websocket_connect(WS_PATH.format(sid=accounts), headers=GM_HEADERS) as ws:
        ws.receive_json()
        ws.send_json({"type": "producer_frame", "payload": {
            "target": "program", "jpeg_b64": base64.b64encode(b"\xff\xd8jpg").decode(), "ts": 12.5}})
        ws.send_json({"id": 2, "type": "presence_get", "payload": {}})
        for _ in range(10):
            if ws.receive_json().get("id") == 2:
                break
    r = client.get("/api/v1/producer/frame/program", headers=h)
    assert r.status_code == 200 and r.content == b"\xff\xd8jpg"
    assert r.headers["cache-control"] == "no-store" and r.headers["x-frame-ts"] == "12.5"


# ── consoles + commands over the socket ──────────────────────────────────────

def test_console_presence_and_command_round_trip(client, accounts):
    h = {"Authorization": f"Bearer {_join(client, accounts, 'gm')}"}
    with client.websocket_connect(WS_PATH.format(sid=accounts), headers=GM_HEADERS) as ws:
        hello = ws.receive_json()["data"]
        assert hello["producer_consoles"] == 0 and hello["pending_producer_commands"] == []

        r = client.post("/api/v1/producer/console/open", headers=h, json={})
        cid = r.json()["console_id"]
        assert r.json()["linked"] is True
        assert _recv_until(ws, "producer_presence")["data"] == {"consoles": 1}

        r = client.post("/api/v1/producer/command", headers=h,
                        json={"cmd": "take", "args": {}, "client_id": "abc"})
        assert r.status_code == 200 and r.json()["status"] == "pending"
        row_id = r.json()["id"]
        ev = _recv_until(ws, "producer_command")["data"]
        assert ev["id"] == row_id and ev["cmd"] == "take" and ev["ttl_s"] == 5.0
        assert ev["client_id"] == "abc" and ev["age_s"] >= 0 and ev["status"] == "pending"

        # still pending: the sync poll and a fresh hello both replay it
        sync = client.get(f"/api/v1/session/{accounts}/sync", headers=GM_HEADERS).json()
        assert [c["id"] for c in sync["pending_producer_commands"]] == [row_id]

        ws.send_json({"id": 9, "type": "producer_ack", "payload": {"id": row_id, "status": "applied", "error": ""}})
        for _ in range(10):
            f = ws.receive_json()
            if f.get("id") == 9:
                assert f["ok"] is True and f["status"] == "applied"
                break
        sync = client.get(f"/api/v1/session/{accounts}/sync", headers=GM_HEADERS).json()
        assert sync["pending_producer_commands"] == []

        client.delete(f"/api/v1/producer/console/{cid}", headers=h)
        assert _recv_until(ws, "producer_presence")["data"] == {"consoles": 0}


def test_unknown_command_rejected_and_ttl_capped(client, accounts):
    h = {"Authorization": f"Bearer {_join(client, accounts, 'gm')}"}
    assert client.post("/api/v1/producer/command", headers=h, json={"cmd": "reboot"}).status_code == 400
    r = client.post("/api/v1/producer/command", headers=h, json={"cmd": "marker", "args": {"note": "x"}, "ttl_s": 999})
    row = client.get(f"/api/v1/session/{accounts}/sync", headers=GM_HEADERS).json()["pending_producer_commands"][-1]
    assert row["id"] == r.json()["id"] and row["ttl_s"] == 60.0


def test_http_ack_fallback(client, accounts):
    h = {"Authorization": f"Bearer {_join(client, accounts, 'gm')}"}
    rid = client.post("/api/v1/producer/command", headers=h, json={"cmd": "arm", "args": {"key": "map"}}).json()["id"]
    r = client.post(f"/api/v1/session/{accounts}/producer/ack", headers=GM_HEADERS,
                    json={"id": rid, "status": "expired", "error": "late"})
    assert r.status_code == 200 and r.json()["status"] == "expired"
    assert client.post(f"/api/v1/session/{accounts}/producer/ack", headers=GM_HEADERS,
                       json={"id": 999999, "status": "applied"}).status_code == 404


# ── SSE visibility ───────────────────────────────────────────────────────────

def test_producer_events_hidden_from_players():
    from routers.stream import event_visible
    assert event_visible({"type": "producer_state"}, True)
    assert not event_visible({"type": "producer_state"}, False)
    assert not event_visible({"type": "producer_ack"}, False)
    assert event_visible({"type": "roll_result"}, False)


def test_hub_console_reaping(monkeypatch):
    import producer_hub as hub
    cid = hub.open_console("hs")
    assert hub.console_count("hs") == 1 and hub.ping_console("hs", cid)
    import time as _t
    monkeypatch.setattr(_t, "monotonic", lambda: 10 ** 6)
    assert hub.console_count("hs") == 0 and not hub.ping_console("hs", cid)
    hub.purge("hs")


def test_barge_and_profile_commands_are_accepted(client, accounts):
    h = {"Authorization": f"Bearer {_join(client, accounts, 'gm')}"}
    for cmd, args in (("barge", {"on": True}), ("producer_profile", {"name": "Eric"}), ("transition", {"name": "Fade", "ms": 500})):
        r = client.post("/api/v1/producer/command", headers=h, json={"cmd": cmd, "args": args})
        assert r.status_code == 200 and r.json()["status"] == "pending", r.text


def test_stale_service_worker_is_evicted(client):
    """A browser that once ran another app on this host:port (Recipe Library
    registers /sw.js) keeps asking for /sw.js; we answer with a worker that
    unregisters itself instead of a 404."""
    r = client.get("/sw.js")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith(("application/javascript", "text/javascript"))
    assert "registration.unregister()" in r.text and "skipWaiting" in r.text
    assert r.headers.get("cache-control") == "no-cache, must-revalidate"
