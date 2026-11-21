#!/usr/bin/env bash
# Package the extension as an .xpi (Firefox uses ZIP files for add-ons).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v zip >/dev/null 2>&1; then
  echo 'zip is required to build the .xpi' >&2
  exit 1
fi

OUT_DIR="${1:-web-ext-artifacts}"
mkdir -p "$OUT_DIR"

VERSION="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])' 2>/dev/null || echo unknown)"
XPI="$OUT_DIR/twitch-vod-unmute-firefox-${VERSION}.xpi"
rm -f "$XPI"

zip -q -r -X "$XPI" \
  manifest.json \
  background.js \
  popup.html \
  popup.css \
  popup.js \
  src \
  icons

echo "Built $XPI"
