"""GM WebSocket endpoint: auth, hello replay, request/reply correlation,
echo filtering, mutation ack, supersede."""
import pytest
from starlette.websockets import WebSocketDisconnect

from tests.conftest import GM_HEADERS, SECRET

WS_PATH = "/api/v1/session/{sid}/gm-ws"


def _connect(client, sid, headers=None):
    return client.websocket_connect(
        WS_PATH.format(sid=sid), headers=headers or GM_HEADERS)


def _recv_until(ws, mtype=None, has_id=None, limit=20):
    """Read frames until one matches (by type or by presence of an id)."""
    for _ in range(limit):
        frame = ws.receive_json()
        if mtype is not None and frame.get("type") == mtype:
            return frame
        if has_id is not None and frame.get("id") == has_id:
            return frame
    raise AssertionError(f"no frame matching type={mtype} id={has_id}")


def test_bad_secret_rejected_before_accept(client, session_id):
    with pytest.raises(WebSocketDisconnect) as exc:
        with _connect(client, session_id, {"X-Relay-Secret": "wrong"}):
            pass
    assert exc.value.code == 4401


def test_unknown_session_rejected(client, session_id):
    with pytest.raises(WebSocketDisconnect) as exc:
        with _connect(client, "no-such-session"):
            pass
    assert exc.value.code == 4404


def test_hello_replays_pending_state(client, session_id):
    with _connect(client, session_id) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        d = hello["data"]
        assert set(d) >= {"pending_mutations", "tokens", "presence",
                          "map_summary", "roll_log", "latest_roll_id"}
        assert d["pending_mutations"] == []


def test_gm_move_creates_token_no_echo_and_replies(client, session_id):
    with _connect(client, session_id) as ws:
        ws.receive_json()                                  # hello
        ws.send_json({"id": 1, "type": "token_move", "payload": {
            "token_id": "t1", "session_id": session_id, "label": "Hero",
            "x_pct": 0.25, "y_pct": 0.5, "token_type": "player",
            "character_id": "char-1"}})
        # In-order queue: if a GM echo existed it would arrive BEFORE this
        # request's reply. The next id-bearing frame must be reply id=1,
        # and no token_move event may precede it.
        frame = ws.receive_json()
        assert frame.get("id") == 1 and frame["ok"] is True, frame
        # follow-up request round-trips cleanly too
        ws.send_json({"id": 2, "type": "presence_get", "payload": {}})
        reply = _recv_until(ws, has_id=2)
        assert reply["ok"] is True and "presence" in reply


def test_player_rest_move_reaches_gm_socket(client, session_id):
    import auth as relay_auth
    with _connect(client, session_id) as ws:
        ws.receive_json()                                  # hello
        # GM creates the token so ownership can match the player's sub
        ws.send_json({"id": 1, "type": "token_move", "payload": {
            "token_id": "t2", "session_id": session_id, "label": "Carl",
            "x_pct": 0.1, "y_pct": 0.1, "token_type": "player",
            "character_id": "carl-sub"}})
        assert ws.receive_json().get("id") == 1
        # player moves it over REST with a JWT
        jwt = relay_auth.issue_player_token("carl-sub", "Carl", session_id, "ben")
        r = client.post("/api/v1/token/move",
                        headers={"Authorization": f"Bearer {jwt}"},
                        json={"token_id": "t2", "x_pct": 0.6, "y_pct": 0.7,
                              "token_type": "player"})
        assert r.status_code == 200, r.text
        ev = _recv_until(ws, mtype="token_move")
        # /sync-shaped token row (key "id") so the GM box reuses its poll code
        assert ev["data"]["id"] == "t2"
        assert ev["data"]["x_pct"] == 0.6
        assert ev["data"]["seq"] >= 1                      # watermark carried


def test_ack_mutations_over_ws(client, session_id):
    """Full loop over public surface: player mutation -> live GM event ->
    WS ack -> gone from the next hello's pending replay."""
    import auth as relay_auth
    # create a character so the mutate endpoint can resolve it
    r = client.post(f"/api/v1/session/{session_id}/characters",
                    headers=GM_HEADERS,
                    json={"characters": [{"player_name": "Carl",
                                          "username": "ben",
                                          "sheet_json": "{}"}],
                          "replace": False})
    assert r.status_code == 200, r.text
    char_id = None
    with _connect(client, session_id) as ws:
        ws.receive_json()                                  # hello
        # find the character id via sync
        s = client.get(f"/api/v1/session/{session_id}/sync", headers=GM_HEADERS)
        chars = s.json()["characters"]
        assert chars, "character not stored"
        char_id = chars[0]["id"]
        jwt = relay_auth.issue_player_token(char_id, "Carl", session_id, "ben")
        r = client.post("/api/v1/character/mutate",
                        headers={"Authorization": f"Bearer {jwt}"},
                        json={"mutation_type": "hp_delta", "data": {"delta": -3}})
        assert r.status_code == 200, r.text
        mid = r.json()["mutation_id"]
        # the mutation arrives as a live event
        ev = _recv_until(ws, mtype="mutation")
        assert ev["data"]["id"] == mid
        assert ev["data"]["mutation_type"] == "hp_delta"
        # ack it over the socket
        ws.send_json({"id": 9, "type": "ack_mutations",
                      "payload": {"mutation_ids": [mid]}})
        reply = _recv_until(ws, has_id=9)
        assert reply["ok"] is True and reply["acked"] == 1
    # acked -> no longer pending in the next hello
    with _connect(client, session_id) as ws2:
        hello = ws2.receive_json()
        assert all(m["id"] != mid for m in hello["data"]["pending_mutations"])


def test_supersede_closes_old_socket(client, session_id):
    with _connect(client, session_id) as ws1:
        ws1.receive_json()                                 # hello
        with _connect(client, session_id) as ws2:
            ws2.receive_json()                             # hello on the new one
            with pytest.raises(WebSocketDisconnect) as exc:
                # old socket drains until its 4409 close
                for _ in range(10):
                    ws1.receive_json()
            assert exc.value.code == 4409
            # new socket still works
            ws2.send_json({"id": 3, "type": "presence_get", "payload": {}})
            assert _recv_until(ws2, has_id=3)["ok"] is True


def test_led_reply_carries_seq(client, session_id):
    with _connect(client, session_id) as ws:
        ws.receive_json()
        ws.send_json({"id": 5, "type": "led",
                      "payload": {"patterns": [{"color": "[1,2,3]"}]}})
        reply = _recv_until(ws, has_id=5)
        assert reply["ok"] is True and reply["seq"] >= 1


def test_unknown_type_is_soft_error(client, session_id):
    with _connect(client, session_id) as ws:
        ws.receive_json()
        ws.send_json({"id": 7, "type": "flux_capacitor", "payload": {}})
        reply = _recv_until(ws, has_id=7)
        assert reply["ok"] is False and reply["error"] == "unknown_type"
        # socket survives the bad message
        ws.send_json({"id": 8, "type": "presence_get", "payload": {}})
        assert _recv_until(ws, has_id=8)["ok"] is True
