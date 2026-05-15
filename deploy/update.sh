#!/usr/bin/env bash
# Pull latest from main, refresh deps, restart the service.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo ">>> git pull"
git pull --ff-only

echo ">>> pip install (in case requirements.txt changed)"
./backend/venv/bin/pip install -r backend/requirements.txt

echo ">>> restart"
sudo systemctl restart lightemup
sleep 1
sudo systemctl --no-pager status lightemup
