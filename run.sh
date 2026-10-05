#!/bin/bash
# Self-contained launcher: downloads a portable Node into ./.node and keeps
# everything (node, npm cache, node_modules) inside this folder.
# Uninstall = delete this folder.
set -euo pipefail
cd "$(dirname "$0")"

# Pick the newest Node line the host actually supports:
#   macOS 10.x (Catalina and older) → v20 — last LTS with a 10.15 build.
#   macOS 11+ (Big Sur and newer)   → v24 — latest.
# Non-macOS falls through to v24 too (Linux builds are published for all lines).
MACOS_MAJOR="$(sw_vers -productVersion 2>/dev/null | cut -d. -f1 || true)"
case "$MACOS_MAJOR" in
  10|9|8|7) NODE_LINE="latest-v20.x" ;;
  *)        NODE_LINE="latest-v24.x" ;;
esac
NODE_MAJOR="$(echo "$NODE_LINE" | sed -E 's/latest-v([0-9]+)\.x/\1/')"

ROOT="$PWD/.node"
export npm_config_cache="$ROOT/npm-cache"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false

# Nuke a stashed Node whose major doesn't match (e.g. a v24 downloaded on an
# M4, then this repo is cloned to a Catalina mini). Also catches binaries
# that fail to launch (dyld symbol errors) — those return empty from --version.
if [ -x "$ROOT/bin/node" ]; then
  CURRENT_MAJOR="$("$ROOT/bin/node" --version 2>/dev/null | sed -E 's/^v([0-9]+)\..*/\1/')"
  if [ "$CURRENT_MAJOR" != "$NODE_MAJOR" ]; then
    echo "Stored Node v${CURRENT_MAJOR:-?} doesn't match pinned v$NODE_MAJOR for this machine. Refreshing…"
    rm -rf "$ROOT"
  fi
fi

if [ ! -x "$ROOT/bin/node" ]; then
  case "$(uname -m)" in
    arm64) ARCH=arm64 ;;
    *)     ARCH=x64 ;;
  esac
  BASE="https://nodejs.org/dist/$NODE_LINE"
  FILE=$(curl -fsSL "$BASE/SHASUMS256.txt" | grep -o "node-v[0-9.]*-darwin-$ARCH.tar.gz" | head -1)
  echo "Downloading $FILE (Node $NODE_LINE for macOS ${MACOS_MAJOR:-?}) …"
  mkdir -p "$ROOT"
  curl -fL --progress-bar "$BASE/$FILE" | tar -xz -C "$ROOT" --strip-components=1
fi

export PATH="$ROOT/bin:$PATH"

if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi

exec npm run "${1:-dev}" -- "${@:2}"
