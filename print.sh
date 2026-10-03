#!/bin/bash
# Print a single photo from this Mac: starts a local server and opens the
# print page in the default browser (needs Chrome for Web Bluetooth).
# localhost counts as a secure context, so no self-signed cert is needed.
cd "$(dirname "$0")"
export PHOTOBOOT_LOCAL=1
exec ./run.sh dev --open /print.html
