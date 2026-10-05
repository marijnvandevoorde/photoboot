#!/bin/bash
# Self-contained launcher: downloads a portable Node into ./.node and keeps
# everything (node, npm cache, node_modules) inside this folder.
# Uninstall = delete this folder.
set -euo pipefail
cd "$(dirname "$0")"

# v20 is the newest Node LTS that still ships macOS 10.15 (Catalina) binaries.
# Bump this once every machine running the booth is on macOS 11+.
NODE_LINE="latest-v20.x"
ROOT="$PWD/.node"
export npm_config_cache="$ROOT/npm-cache"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false

if [ ! -x "$ROOT/bin/node" ]; then
  case "$(uname -m)" in
    arm64) ARCH=arm64 ;;
    *)     ARCH=x64 ;;
  esac
  BASE="https://nodejs.org/dist/$NODE_LINE"
  FILE=$(curl -fsSL "$BASE/SHASUMS256.txt" | grep -o "node-v[0-9.]*-darwin-$ARCH.tar.gz" | head -1)
  echo "Downloading $FILE ..."
  mkdir -p "$ROOT"
  curl -fL --progress-bar "$BASE/$FILE" | tar -xz -C "$ROOT" --strip-components=1
fi

export PATH="$ROOT/bin:$PATH"

if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi

exec npm run "${1:-dev}" -- "${@:2}"
