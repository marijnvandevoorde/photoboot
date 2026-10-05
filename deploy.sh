#!/bin/bash
# Deploy to the server: copies the project to ~/photoboot and (re)starts it
# behind Traefik at https://boot.small-victories.co.
#
#   ./deploy.sh ubuntu@<server>
set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:?usage: ./deploy.sh ubuntu@<server>}"

# Plain tar over ssh (no rsync on the server). Replaces everything in
# ~/photoboot except a server-side .env.
COPYFILE_DISABLE=1 tar -cz \
  --exclude node_modules --exclude .node --exclude dist --exclude shares --exclude events \
  --exclude .git --exclude .env --exclude .DS_Store --exclude .vite --exclude template-assets \
  . | ssh "$TARGET" '
  mkdir -p ~/photoboot
  find ~/photoboot -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} +
  tar -xz -C ~/photoboot
'

ssh "$TARGET" '
  set -e
  sudo mkdir -p /storage/photoboot/shares /storage/photoboot/events
  sudo chown -R 1000:1000 /storage/photoboot/shares /storage/photoboot/events
  cd ~/photoboot
  docker compose up -d --build
  docker compose ps
'
