#!/usr/bin/env bash
# Build Firefox (.xpi) and Chrome (.zip, optional .crx) packages.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

OUT_DIR="web-ext-artifacts"
BUILD_FIREFOX=0
BUILD_CHROME=0
DO_SIGN=0
DO_CRX=0
DO_VERIFY=1
STRICT_LINT=0
VERIFY_XPI=""
WEB_EXT="${WEB_EXT:-web-ext}"

usage() {
  cat <<'EOF'
Usage: ./build-all.sh [options]

Options:
  --firefox        Build only the Firefox XPI
  --chrome         Build only the Chrome ZIP
  --sign           Ask AMO to sign the Firefox XPI (unlisted channel)
  --crx            Also pack a local Chrome CRX (needs CHROME_KEY)
  --out DIR        Output directory (default: web-ext-artifacts)
  --verify-xpi FILE  Verify an existing Firefox XPI, then exit
  --no-verify      Skip local archive verification
  --strict-lint    Treat web-ext lint warnings as errors
  -h, --help       Show this help

Environment:
  WEB_EXT          web-ext binary (default: web-ext)
  WEB_EXT_API_KEY  AMO JWT issuer, required with --sign
  WEB_EXT_API_SECRET AMO JWT secret, required with --sign
  CHROME_BIN       Chrome/Chromium binary used with --crx
  CHROME_KEY       Path to a .pem key used with --crx
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --firefox) BUILD_FIREFOX=1; shift ;;
    --chrome) BUILD_CHROME=1; shift ;;
    --sign) DO_SIGN=1; BUILD_FIREFOX=1; shift ;;
    --crx) DO_CRX=1; BUILD_CHROME=1; shift ;;
    --out) [ "$#" -ge 2 ] || { echo '--out requires a directory' >&2; exit 2; }; OUT_DIR="$2"; shift 2 ;;
    --verify-xpi) [ "$#" -ge 2 ] || { echo '--verify-xpi requires a file' >&2; exit 2; }; VERIFY_XPI="$2"; shift 2 ;;
    --no-verify) DO_VERIFY=0; shift ;;
    --strict-lint) STRICT_LINT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$BUILD_FIREFOX" -eq 0 ] && [ "$BUILD_CHROME" -eq 0 ]; then
  BUILD_FIREFOX=1
  BUILD_CHROME=1
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 1
  fi
}

need python3
if [ -z "$VERIFY_XPI" ]; then
  need zip
  need unzip
  if [ "$BUILD_FIREFOX" -eq 1 ]; then need "$WEB_EXT"; fi
fi

if [ "$DO_SIGN" -eq 1 ] && [ -z "$VERIFY_XPI" ]; then
  : "${WEB_EXT_API_KEY:?WEB_EXT_API_KEY is required with --sign}"
  : "${WEB_EXT_API_SECRET:?WEB_EXT_API_SECRET is required with --sign}"
fi

python3 - <<'PY'
import json
ff = json.load(open('manifest.firefox.json'))
ch = json.load(open('manifest.chrome.json'))
if ff.get('version') != ch.get('version'):
    raise SystemExit('manifest versions differ: %s vs %s' % (
        ff.get('version'), ch.get('version')))
PY

VERSION="$(python3 -c 'import json; print(json.load(open("manifest.firefox.json"))["version"])')"
mkdir -p "$OUT_DIR"
OUT_ABS="$(cd "$OUT_DIR" && pwd)"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/tvu-build.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

copy_shared() {
  local dest="$1"
  mkdir -p "$dest/src" "$dest/icons"
  cp popup.html popup.css popup.js "$dest/"
  cp -R src/. "$dest/src/"
  cp -R icons/. "$dest/icons/"
}

verify_archive() {
  local file="$1"
  local kind="$2"
  python3 - "$file" "$kind" "$VERSION" <<'PY'
import json
import sys
import zipfile

path, kind, expected_version = sys.argv[1:4]
forbidden = ('tests/', 'build-all.sh', 'build-xpi.sh', 'README.md',
             'PROVENANCE.md', 'LICENSE', '.gitignore', 'web-ext-artifacts/',
             'manifest.firefox.json', 'manifest.chrome.json')

with zipfile.ZipFile(path) as archive:
    names = archive.namelist()
    if 'manifest.json' not in names:
        raise SystemExit('%s: manifest.json is not at the archive root' % path)
    for prefix in forbidden:
        if any(name.startswith(prefix) for name in names):
            raise SystemExit('%s: dev file packaged: %s' % (path, prefix))
    manifest = json.loads(archive.read('manifest.json'))

if manifest.get('version') != expected_version:
    raise SystemExit('%s: unexpected version %r' % (path, manifest.get('version')))

if kind == 'chrome':
    if 'browser_specific_settings' in manifest:
        raise SystemExit('chrome package contains Firefox-only settings')
    if not manifest.get('background', {}).get('service_worker'):
        raise SystemExit('chrome package has no service worker')
    permissions = manifest.get('permissions', [])
    if 'declarativeNetRequest' not in permissions:
        raise SystemExit('chrome package is missing declarativeNetRequest')
    if 'webRequestBlocking' in permissions:
        raise SystemExit('chrome package contains webRequestBlocking')
else:
    scripts = manifest.get('background', {}).get('scripts', [])
    if not scripts:
        raise SystemExit('firefox package has no background scripts')
    if 'webRequestBlocking' not in manifest.get('permissions', []):
        raise SystemExit('firefox package is missing webRequestBlocking')
PY
}

verify_signature() {
  python3 - "$1" <<'PY'
import sys
import zipfile

path = sys.argv[1]
with zipfile.ZipFile(path) as archive:
    names = set(archive.namelist())

if 'META-INF/mozilla.rsa' not in names:
    print('XPI is unsigned (no META-INF/mozilla.rsa).')
    print('It can be loaded temporarily, but Release/Beta Firefox will not')
    print('install it permanently. Use --sign with AMO credentials for that.')
    raise SystemExit(0)

missing = [name for name in ('META-INF/manifest.mf', 'META-INF/mozilla.sf')
           if name not in names]
if missing:
    raise SystemExit('%s: incomplete Mozilla signature: missing %s' % (
        path, ', '.join(missing)))
extra = 'META-INF/cose.sig' if 'META-INF/cose.sig' in names else None
print('XPI is Mozilla-signed' + (' (COSE signature present)' if extra else '') + '.')
PY
}

if [ -n "$VERIFY_XPI" ]; then
  if [ ! -f "$VERIFY_XPI" ]; then
    echo "XPI not found: $VERIFY_XPI" >&2
    exit 1
  fi
  verify_archive "$VERIFY_XPI" firefox
  verify_signature "$VERIFY_XPI"
  exit 0
fi

BUILT=()

if [ "$BUILD_FIREFOX" -eq 1 ]; then
  FF_STAGE="$TMP/firefox"
  copy_shared "$FF_STAGE"
  cp manifest.firefox.json "$FF_STAGE/manifest.json"
  cp background.js "$FF_STAGE/"

  echo 'Validating Firefox package...'
  LINT_ARGS=(lint --source-dir "$FF_STAGE" --config "$ROOT/web-ext-config.cjs" --self-hosted)
  if [ "$STRICT_LINT" -eq 1 ]; then LINT_ARGS+=(--warnings-as-errors); fi
  "$WEB_EXT" "${LINT_ARGS[@]}"

  FF_XPI="$OUT_ABS/twitch-vod-unmute-${VERSION}.xpi"
  rm -f "$FF_XPI"
  "$WEB_EXT" build \
    --source-dir "$FF_STAGE" \
    --config "$ROOT/web-ext-config.cjs" \
    --artifacts-dir "$OUT_ABS" \
    --filename "twitch-vod-unmute-${VERSION}.xpi" \
    --overwrite-dest

  if [ ! -f "$FF_XPI" ]; then
    echo "Firefox build did not produce $FF_XPI" >&2
    exit 1
  fi
  if [ "$DO_VERIFY" -eq 1 ]; then verify_archive "$FF_XPI" firefox; fi
  BUILT+=("$FF_XPI")

  if [ "$DO_SIGN" -eq 1 ]; then
    echo 'Requesting unlisted Mozilla signature...'
    MARKER="$TMP/sign.marker"
    touch "$MARKER"
    "$WEB_EXT" sign \
      --source-dir "$FF_STAGE" \
      --config "$ROOT/web-ext-config.cjs" \
      --artifacts-dir "$OUT_ABS" \
      --channel unlisted \
      --api-key "$WEB_EXT_API_KEY" \
      --api-secret "$WEB_EXT_API_SECRET"

    SIGNED_XPI="$(find "$OUT_ABS" -maxdepth 1 -type f -name '*.xpi' -newer "$MARKER" -print | sort | head -n 1)"
    if [ -z "$SIGNED_XPI" ]; then
      echo 'web-ext sign did not produce a signed XPI' >&2
      exit 1
    fi
    if [ "$DO_VERIFY" -eq 1 ]; then
      verify_archive "$SIGNED_XPI" firefox
      verify_signature "$SIGNED_XPI"
    fi
    BUILT+=("$SIGNED_XPI")
  fi
fi

if [ "$BUILD_CHROME" -eq 1 ]; then
  CH_STAGE="$TMP/chrome"
  copy_shared "$CH_STAGE"
  cp manifest.chrome.json "$CH_STAGE/manifest.json"
  cp background-chrome.js "$CH_STAGE/"

  CH_ZIP="$OUT_ABS/twitch-vod-unmute-chrome-${VERSION}.zip"
  rm -f "$CH_ZIP"
  (cd "$CH_STAGE" && zip -q -r -X "$CH_ZIP" .)

  if [ "$DO_VERIFY" -eq 1 ]; then verify_archive "$CH_ZIP" chrome; fi
  BUILT+=("$CH_ZIP")

  if [ "$DO_CRX" -eq 1 ]; then
    : "${CHROME_KEY:?CHROME_KEY is required with --crx}"
    if [ ! -f "$CHROME_KEY" ]; then
      echo "CHROME_KEY does not exist: $CHROME_KEY" >&2
      exit 1
    fi
    CHROME_BIN="${CHROME_BIN:-}"
    if [ -z "$CHROME_BIN" ]; then
      for candidate in google-chrome chromium chromium-browser; do
        if command -v "$candidate" >/dev/null 2>&1; then
          CHROME_BIN="$(command -v "$candidate")"
          break
        fi
      done
    fi
    if [ -z "$CHROME_BIN" ]; then
      echo 'No Chrome/Chromium binary found; set CHROME_BIN' >&2
      exit 1
    fi
    KEY_ABS="$(cd "$(dirname "$CHROME_KEY")" && pwd)/$(basename "$CHROME_KEY")"
    CH_CRX="$OUT_ABS/twitch-vod-unmute-chrome-${VERSION}.crx"
    rm -f "$CH_CRX"
    "$CHROME_BIN" \
      --headless --no-sandbox --disable-gpu \
      --pack-extension="$CH_STAGE" \
      --pack-extension-key="$KEY_ABS" \
      --out="$CH_CRX"
    if [ ! -f "$CH_CRX" ]; then
      echo "Chrome pack did not produce $CH_CRX" >&2
      exit 1
    fi
    BUILT+=("$CH_CRX")
  fi
fi

echo
echo 'Built:'
for file in "${BUILT[@]}"; do
  echo "  $file"
done

if [ "$DO_SIGN" -eq 0 ] && [ "$BUILD_FIREFOX" -eq 1 ]; then
  echo
  echo 'Firefox XPI is unsigned. Permanent install in Release/Beta requires'
  echo 'web-ext sign --channel unlisted with AMO credentials, or use'
  echo 'about:debugging / Firefox Developer Edition / Nightly / ESR.'
fi
