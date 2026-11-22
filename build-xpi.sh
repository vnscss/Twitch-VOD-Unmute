#!/usr/bin/env bash
# Backwards-compatible wrapper for the Firefox-only build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/build-all.sh" --firefox "$@"
