#!/usr/bin/env bash
# Copy the built engine into the world's public/ so the dev server and the
# upload bundle serve it under ${baseUrl}engine/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HERE/public/engine"
cp "$HERE/../engine/dist/ysflight32_gl2.js" "$HERE/../engine/dist/ysflight32_gl2.wasm" "$HERE/../engine/dist/ysflight32_gl2.data" "$HERE/public/engine/"
ls -la "$HERE/public/engine"
