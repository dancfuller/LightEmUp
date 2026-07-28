#!/usr/bin/env bash
# Allow passwordless control of the lightemup service, so deploys can run
# unattended (no TTY) instead of dying at the sudo prompt.
#
#   sudo ~/lightemup/deploy/install-sudoers.sh
#
# Run once. Safe to re-run.
set -euo pipefail

DEST=/etc/sudoers.d/lightemup

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo:  sudo $0" >&2
  exit 1
fi

# Grant to whoever invoked sudo, not a hardcoded "pi" — the account differs
# across Raspberry Pi OS installs.
USER_NAME="${SUDO_USER:-}"
if [ -z "$USER_NAME" ] || [ "$USER_NAME" = "root" ]; then
  echo "Could not determine the invoking user (\$SUDO_USER)." >&2
  echo "Run as your normal user via sudo, not as root directly." >&2
  exit 1
fi

# systemctl lives in /usr/bin on current Raspberry Pi OS and /bin on older
# images; sudoers matches on the literal path, so authorise both.
SYSTEMCTL_PATHS=()
for p in /usr/bin/systemctl /bin/systemctl; do
  [ -x "$p" ] && SYSTEMCTL_PATHS+=("$p")
done
if [ ${#SYSTEMCTL_PATHS[@]} -eq 0 ]; then
  echo "systemctl not found in /usr/bin or /bin." >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

{
  echo "# Installed by deploy/install-sudoers.sh — passwordless control of the"
  echo "# lightemup service so deploys don't need an interactive terminal."
  echo "#"
  echo "# Deliberately NARROW: restart / daemon-reload / status only. Installing the"
  echo "# systemd UNIT is left out on purpose — a rule that lets you write an"
  echo "# arbitrary unit file and reload it is equivalent to handing over root, and"
  echo "# the unit changes about once a year, so it isn't worth that trade."
  for sc in "${SYSTEMCTL_PATHS[@]}"; do
    echo "$USER_NAME ALL=(root) NOPASSWD: $sc restart lightemup"
    echo "$USER_NAME ALL=(root) NOPASSWD: $sc daemon-reload"
    echo "$USER_NAME ALL=(root) NOPASSWD: $sc status lightemup"
    echo "$USER_NAME ALL=(root) NOPASSWD: $sc --no-pager status lightemup"
  done
} > "$TMP"

# Validate BEFORE installing. A malformed file in /etc/sudoers.d can break sudo
# for every user on the box, which on a headless Pi means a reimage.
if ! visudo -c -f "$TMP" >/dev/null; then
  echo "Generated sudoers file is invalid — nothing was installed." >&2
  exit 1
fi

install -m 0440 -o root -g root "$TMP" "$DEST"

# Re-validate the whole config now that it's in place; roll back if unhappy.
if ! visudo -c >/dev/null; then
  rm -f "$DEST"
  echo "sudoers validation failed after install — reverted, nothing changed." >&2
  exit 1
fi

echo "Installed $DEST for user '$USER_NAME':"
sed 's/^/    /' "$DEST"
echo
echo "Deploys can now restart the service without a password:"
echo "    ssh pi@lightemup '~/lightemup/deploy/update.sh'"
echo "To undo:  sudo rm $DEST"
