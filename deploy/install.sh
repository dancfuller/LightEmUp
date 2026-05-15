#!/usr/bin/env bash
# One-shot installer. Run as the 'pi' user (not root). Re-runnable.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/dancfuller/LightEmUp.git}"
APP_DIR="$HOME/lightemup"

echo ">>> apt: installing system deps"
sudo apt update
sudo apt install -y git python3-venv python3-pip avahi-daemon avahi-utils

if [ ! -d "$APP_DIR/.git" ]; then
  echo ">>> cloning $REPO_URL into $APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
else
  echo ">>> repo already present, pulling latest"
  git -C "$APP_DIR" pull --ff-only
fi

echo ">>> python venv + deps"
cd "$APP_DIR/backend"
if [ ! -d venv ]; then
  python3 -m venv venv
fi
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

if [ ! -f config.json ]; then
  cp config.json.example config.json
  echo ">>> seeded config.json from example. If you scp'd one from Windows, overwrite this file before the service starts working fully."
fi

echo ">>> installing systemd unit"
sudo cp "$APP_DIR/deploy/lightemup.service" /etc/systemd/system/lightemup.service
sudo systemctl daemon-reload
sudo systemctl enable lightemup.service

echo ">>> installing avahi mDNS service"
sudo cp "$APP_DIR/deploy/lightemup.avahi.service" /etc/avahi/services/lightemup.service

echo ">>> starting lightemup"
sudo systemctl restart lightemup.service
sleep 2
sudo systemctl --no-pager status lightemup.service || true

echo
echo "Done. App should be reachable at:"
echo "  http://lightemup.local:8420"
echo
echo "Useful commands:"
echo "  sudo systemctl status lightemup     # state"
echo "  journalctl -u lightemup -f          # live logs"
echo "  ~/lightemup/deploy/update.sh        # pull latest + restart"
