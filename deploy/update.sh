#!/usr/bin/env bash
# Pull latest from main, refresh deps, restart the service.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo ">>> git pull"
git pull --ff-only

echo ">>> pip install (in case requirements.txt changed)"
./backend/venv/bin/pip install -r backend/requirements.txt

# Refresh systemd unit if deploy/lightemup.service changed.
if ! sudo cmp -s "$APP_DIR/deploy/lightemup.service" /etc/systemd/system/lightemup.service; then
  echo ">>> systemd unit changed — reinstalling"
  sudo cp "$APP_DIR/deploy/lightemup.service" /etc/systemd/system/lightemup.service
  sudo systemctl daemon-reload
fi

echo ">>> restart"
sudo systemctl restart lightemup
sleep 1
sudo systemctl --no-pager status lightemup
