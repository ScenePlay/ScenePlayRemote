import os
import sys
from contextlib import asynccontextmanager

# Ensure the relay/ directory is on sys.path so sibling modules can be
# imported without relative syntax — works both as `uvicorn relay.main:app`
# (from project root) and `uvicorn main:app` (from inside relay/).
sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import db
import mqtt_bridge
from routers import audio, gm, gm_ws, player, stream, sync, tokens

_PORTAL_DIR = os.path.join(os.path.dirname(__file__), "portal")


@asynccontextmanager
async def lifespan(app: FastAPI):
    for _sub in ("portraits", "battlemaps", "monsters", "textures"):
        os.makedirs(os.path.join(_PORTAL_DIR, _sub), exist_ok=True)
    await db.database.connect()
    await db.create_tables()
    mqtt_bridge.start()   # no-op unless MQTT_HOST is configured
    yield
    mqtt_bridge.stop()
    await db.database.disconnect()


app = FastAPI(title="ScenePlay Relay", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# Force the browser to revalidate the portal shell/code on every load so a new
# app.js/style.css is never hidden behind a stale cache. ETag/Last-Modified make
# this cheap (304 when unchanged); images are left cacheable.
@app.middleware("http")
async def _no_cache_portal(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response

# Deploy-verification probe: confirms which build is live and that the SQLite
# hardening took effect (journal_mode must read 'wal' — see db.create_tables).
@app.get("/api/v1/health")
async def health():
    journal_mode = None
    try:
        row = await db.database.fetch_one("PRAGMA journal_mode")
        journal_mode = row[0] if row else None
    except Exception:
        pass
    return {"ok": True, "journal_mode": journal_mode}


_PREFIX = "/api/v1"
app.include_router(gm.router, prefix=_PREFIX)
app.include_router(player.router, prefix=_PREFIX)
app.include_router(tokens.router, prefix=_PREFIX)
app.include_router(stream.router, prefix=_PREFIX)
app.include_router(sync.router, prefix=_PREFIX)
app.include_router(audio.router, prefix=_PREFIX)
app.include_router(gm_ws.router, prefix=_PREFIX)

# Player portal served at /  — must be mounted last so API routes take priority
app.mount("/", StaticFiles(directory=_PORTAL_DIR, html=True), name="portal")

if __name__ == "__main__":
    import uvicorn
    from config import HOST, PORT
    uvicorn.run("main:app", host=HOST, port=PORT, reload=True)
