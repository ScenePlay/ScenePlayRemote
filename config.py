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

_raw_db_url: str = os.environ.get("DATABASE_URL", "sqlite:///./relay.db")
# Normalise the sqlite+aio:// shorthand used in render.yaml
DATABASE_URL: str = (
    "sqlite:" + _raw_db_url[len("sqlite+aio"):]
    if _raw_db_url.startswith("sqlite+aio:")
    else _raw_db_url
)
PORT: int = int(os.environ.get("PORT", "8000"))
