"""Relay test fixtures: scratch sqlite + secrets via env (set BEFORE config
import), app served through FastAPI's TestClient with lifespan running."""
import os
import sys
import tempfile

os.environ.setdefault("RELAY_SECRET", "test-secret")
os.environ.setdefault("JWT_SECRET", "test-jwt")
if "DATABASE_URL" not in os.environ:
    _db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    _db.close()
    os.environ["DATABASE_URL"] = f"sqlite:///{_db.name}"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest                              # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

SECRET = os.environ["RELAY_SECRET"]
GM_HEADERS = {"X-Relay-Secret": SECRET}


@pytest.fixture(scope="session")
def client():
    from main import app
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def session_id(client):
    """Fresh relay session (create purges previous sessions/media)."""
    r = client.post("/api/v1/session/create", headers=GM_HEADERS, json={})
    assert r.status_code == 200, r.text
    return r.json()["session_id"]
