import os
from pathlib import Path

# Load .env from the project root (two levels up from this file) or the CWD.
# No-op when running on Render where the real env vars are already set.
try:
    from dotenv import load_dotenv
    for _candidate in (
        Path(__file__).parent.parent / ".env",   # project root
        Path(".env"),                             # CWD
    ):
        if _candidate.exists():
            load_dotenv(_candidate)
            break
except ImportError:
    pass


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"Required environment variable '{name}' is not set. "
            "Copy .env.example to .env and fill in the values."
        )
    return value


RELAY_SECRET: str = _require("RELAY_SECRET")
JWT_SECRET: str = _require("JWT_SECRET")
SCENEPLAY_URL: str | None = os.environ.get("SCENEPLAY_URL")

_raw_db_url: str = os.environ.get("DATABASE_URL", "sqlite:///./relay.db")
# Normalise the sqlite+aio:// shorthand used in render.yaml
DATABASE_URL: str = (
    "sqlite:" + _raw_db_url[len("sqlite+aio"):]
    if _raw_db_url.startswith("sqlite+aio:")
    else _raw_db_url
)
PORT: int = int(os.environ.get("PORT", "8000"))
HOST: str = os.environ.get("HOST", "0.0.0.0")

# ── MQTT bridge (optional — Option A for WLED) ────────────────────────────────
# When MQTT_HOST is set, the relay publishes each session's WLED lighting
# state to a per-player topic on this broker; players point their WLED's
# built-in MQTT client at the same broker (outbound from their LAN, so no
# HTTPS→HTTP mixed-content problem and no player-side software). Unset = off.
MQTT_HOST: str = os.environ.get("MQTT_HOST", "")
MQTT_PORT: int = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_USERNAME: str = os.environ.get("MQTT_USERNAME", "")
MQTT_PASSWORD: str = os.environ.get("MQTT_PASSWORD", "")
MQTT_TLS: bool = os.environ.get("MQTT_TLS", "0") == "1"
MQTT_TOPIC_PREFIX: str = os.environ.get("MQTT_TOPIC_PREFIX", "sceneplay")
# Address players type into their WLED settings (defaults to MQTT_HOST —
# differs when the relay reaches the broker over a private network).
MQTT_PUBLIC_HOST: str = os.environ.get("MQTT_PUBLIC_HOST", "") or MQTT_HOST
MQTT_PUBLIC_PORT: int = int(os.environ.get("MQTT_PUBLIC_PORT", "0")) or MQTT_PORT
