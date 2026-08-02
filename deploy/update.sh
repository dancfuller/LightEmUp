#!/usr/bin/env bash
# Pull latest from main, refresh deps, restart the service.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

UNIT_SRC="$APP_DIR/deploy/lightemup.service"
UNIT_DEST=/etc/systemd/system/lightemup.service

SYSTEMCTL="$(command -v systemctl || echo /usr/bin/systemctl)"

have_tty() { [ -t 0 ]; }

# Can we restart the service without a password?
#
# This must ask about the EXACT command we need, not about sudo in general.
# `sudo -n true` looks like the obvious probe and is wrong here: install-sudoers.sh
# deliberately grants only restart / daemon-reload / status, so /bin/true is NOT
# authorised and the probe failed on a box where the deploy would have worked
# perfectly. `sudo -l <cmd>` asks "am I allowed to run this?" without running it.
# The `sudo -n true` fallback covers a box with blanket passwordless sudo.
sudo_free() {
  sudo -n -l "$SYSTEMCTL" restart lightemup >/dev/null 2>&1 || sudo -n true 2>/dev/null
}

# ── Fail BEFORE touching anything ───────────────────────────────────────────
# A deploy that pulls new files and then can't restart leaves the worst possible
# state: new frontend on disk, old backend running, so the browser calls
# endpoints the running server doesn't have. Check we can actually finish first.
if ! sudo_free && ! have_tty; then
  cat >&2 <<'EOF'
!!! sudo needs a password and there is no terminal to ask on, so the service
!!! could not be restarted. NOTHING has been changed. Either:
!!!
!!!   run it from an interactive shell:
!!!     ssh -t pi@lightemup '~/lightemup/deploy/update.sh'
!!!
!!!   or allow passwordless service control once (then this works unattended):
!!!     ssh -t pi@lightemup 'sudo ~/lightemup/deploy/install-sudoers.sh'
EOF
  exit 1
fi

echo ">>> git pull"
git pull --ff-only

echo ">>> pip install (in case requirements.txt changed)"
./backend/venv/bin/pip install -r backend/requirements.txt

# ── Refresh the systemd unit only if it actually changed ─────────────────────
# Compare WITHOUT sudo. The installed unit is world-readable, so sudo bought
# nothing here and cost a password prompt on EVERY deploy. It was also actively
# harmful: when sudo couldn't prompt, its non-zero exit was indistinguishable
# from "the files differ", so the script entered the reinstall branch and then
# died under `set -e` at the copy — BEFORE the restart. That's exactly how a
# deploy once left new files on disk with the old server still running.
if ! cmp -s "$UNIT_SRC" "$UNIT_DEST" 2>/dev/null; then
  echo ">>> systemd unit changed — reinstalling"
  # Installing a unit is NOT covered by the passwordless rule (writing an
  # arbitrary unit + reload is equivalent to root), so this may prompt. If it
  # can't, carry on to the restart anyway: shipping the code change still beats
  # aborting, and the unit changes about once a year.
  if sudo cp "$UNIT_SRC" "$UNIT_DEST"; then
    sudo systemctl daemon-reload
  else
    echo "!!! Could not install the new unit file (needs an interactive sudo)." >&2
    echo "!!! Continuing to the restart so the CODE change still goes live." >&2
    echo "!!! Re-run from a terminal to pick up the unit change itself." >&2
  fi
fi

echo ">>> restart"
sudo systemctl restart lightemup
sleep 2

# ── Confirm the thing that's actually running is the thing we just pulled ────
# The version + git hash are cached at import, so this proves the process really
# restarted rather than surviving with stale code.
echo ">>> verify"
if command -v curl >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:8420/api/version; then
  echo
else
  echo "(version endpoint not answering — check the status below)"
fi
echo ">>> expected: $(git rev-parse --short HEAD)"

sudo systemctl --no-pager status lightemup
