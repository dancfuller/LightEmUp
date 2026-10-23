#!/usr/bin/env bash
# Install the pinned esbuild binary the server compiles the frontend with (v3.64.0).
#
# The browser used to compile all of static/js/*.js with Babel on EVERY page
# load — ~4s on a desktop, far longer on a phone. The server now does it once at
# startup with esbuild (see backend/CLAUDE.md "Precompiled frontend"). This puts
# that one binary at ~/lightemup/.tools/esbuild. No Node, no npm, no sudo.
#
# Idempotent: does nothing if the right version is already there. update.sh runs
# it on every deploy. If it fails, the server still works — it falls back to the
# old in-browser Babel path and logs a warning.
set -euo pipefail

VERSION=0.24.2
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$APP_DIR/.tools/esbuild"

if [ -x "$DEST" ] && [ "$("$DEST" --version 2>/dev/null)" = "$VERSION" ]; then
  echo "esbuild $VERSION already installed"
  exit 0
fi

# The npm registry's per-platform packages hold just the binary. Pinned by
# version AND by the tarball's sha256, so a changed upload is refused.
case "$(uname -m)" in
  aarch64|arm64) PKG=linux-arm64; SHA=7df901475cebc48a59a7ea64fcc75c9a95018fc56faa721ccc1f4cbf213f0e16 ;;
  x86_64)        PKG=linux-x64;   SHA=aa469e907204bade7c37df6376f7ce3562574e937a61984ba8b89db63e03883a ;;
  armv7l|armv6l) PKG=linux-arm;   SHA=c3e81cdb9d1aac407f898ff83cc1399e896001d804e734ba147b6290934d47d4 ;;
  *) echo "!!! no esbuild build pinned for $(uname -m); the page will use in-browser Babel" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL --max-time 120 -o "$TMP/esbuild.tgz" \
  "https://registry.npmjs.org/@esbuild/$PKG/-/$PKG-$VERSION.tgz"
echo "$SHA  $TMP/esbuild.tgz" | sha256sum -c --quiet -
tar -xzf "$TMP/esbuild.tgz" -C "$TMP" package/bin/esbuild
mkdir -p "$(dirname "$DEST")"
install -m 755 "$TMP/package/bin/esbuild" "$DEST"
echo "installed esbuild $("$DEST" --version) at $DEST"
