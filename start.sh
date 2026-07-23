#!/usr/bin/env bash
# Start ScenePlay Remote (installed by ./install.sh).
# Honors HOST/PORT from .env; runs without the dev auto-reloader.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "No .env found — run ./install.sh first."; exit 1; }
[ -x .venv/bin/python ] || { echo "No .venv found — run ./install.sh first."; exit 1; }
exec ./.venv/bin/python -c "import config, uvicorn; uvicorn.run('main:app', host=config.HOST, port=config.PORT)"
