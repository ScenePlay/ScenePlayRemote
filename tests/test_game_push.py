"""Game-system push: local tells remote which rules a session follows; remote
stores it for late joiners (session_state / sync) and broadcasts game_update."""
from conftest import GM_HEADERS

GAME = {"id": "dcc", "name": "Dungeon Crawler Carl", "settings": {"floor": 4}}


def test_push_stores_and_sync_returns_it(client, session_id):
    r = client.post(f"/api/v1/session/{session_id}/game", headers=GM_HEADERS,
                    json={"game": GAME})
    assert r.status_code == 200 and r.json() == {"ok": True}
    s = client.get(f"/api/v1/session/{session_id}/sync", headers=GM_HEADERS).json()
    assert s["session"]["game"] == GAME
    assert "game_json" not in s["session"]


def test_sync_without_push_has_no_game(client, session_id):
    s = client.get(f"/api/v1/session/{session_id}/sync", headers=GM_HEADERS).json()
    assert s["session"]["game"] is None


def test_bad_secret_rejected(client, session_id):
    r = client.post(f"/api/v1/session/{session_id}/game",
                    headers={"X-Relay-Secret": "nope"}, json={"game": GAME})
    assert r.status_code == 401


def test_unknown_session_404(client):
    r = client.post("/api/v1/session/nope/game", headers=GM_HEADERS, json={"game": GAME})
    assert r.status_code == 404
