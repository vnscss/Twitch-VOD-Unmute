# Twitch VOD Unmute (Firefox)

> **This project is a reimplementation.** It is not the original Chrome
> extension, and it is not published by, affiliated with, or endorsed by the
> original author.
>
> **This repository was made with AI assistance** (OpenCode). The code, tests,
> and documentation were generated and reviewed with AI help.

A Firefox Manifest V3 extension that restores audio to muted Twitch VODs when
Twitch still serves the original (unmuted) media segments on its CDN.

## What it does

When Twitch serves a muted VOD playlist, this extension:

1. Detects the `index-muted-*.m3u8` media playlist.
2. Reads the playlist and finds the muted `.ts`/`.mp4` segments.
3. Probes the corresponding unmuted segment URLs in the quality ladder.
4. Holds the player's segment requests until probing finishes.
5. Redirects only the requests whose original segment is still available.
6. Optionally colours the seekbar to show which parts were recovered.

Segments that Twitch has permanently purged remain muted; the extension cannot
recreate audio that is no longer served by the CDN.

## Install

### Temporary install (developer mode)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…**.
3. Select this repository's `manifest.json`.

The add-on is removed when Firefox restarts.

### Run with `web-ext`

```sh
web-ext run --source-dir .
```

Build a packaged XPI with the included script (requires `zip` and `python3`):

```sh
./build-xpi.sh
# writes web-ext-artifacts/twitch-vod-unmute-firefox-<version>.xpi
```

You can then install the `.xpi` from `about:addons` or by dragging it onto a
Firefox window. `web-ext build --source-dir .` also works if you already have
`web-ext` installed.

Firefox 115 or newer is required (`strict_min_version` in `manifest.json`).

## Usage

1. Install the extension and open a Twitch VOD in Firefox.
2. Wait a few seconds for the first muted playlist to be scanned.
3. Click the toolbar icon to see the last scan result and change options.
4. Refresh the VOD after changing an option.

Options:

| Option | Meaning |
| --- | --- |
| **Extension enabled** | Turns scanning and redirection off. Turning it off clears existing redirects. |
| **Colour the seekbar** | Draws recovered/purged ranges over Twitch's seekbar. |
| **Allow lower-quality segments** | Uses a lower quality only when it shares the current quality's base codec. |
| **Recovered / Lower quality / Still muted** | Seekbar colours. |
| **Opacity** | Alpha applied to the seekbar colours. |

Seekbar colours: green = recovered at the selected quality, orange = recovered
from a compatible lower quality, red = still muted.

## How it works

The original Chrome extension used `declarativeNetRequest` rules and injected
page scripts to probe Twitch's CDN. Firefox Manifest V3 does not support the
same `service_worker`/DNR combination, so this port uses:

- `webRequest.onCompleted` to observe playlist requests.
- `webRequest.onBeforeRequest` with `blocking` to redirect segment requests.
- `browser.scripting.executeScript` in the page's `MAIN` world to read
  playlists and probe unmuted segments with CORS-compatible requests.
- `browser.storage.sync` for settings and `browser.storage.session` for
  per-session redirects, probe results, and statistics.

Player segment requests are held briefly while the scan runs so the first
segments are not missed. The extension's own playlist reads are ignored to
avoid rescanning its own traffic.

## Permissions

| Permission | Why |
| --- | --- |
| `webRequest`, `webRequestBlocking` | Observe playlists and redirect segment requests. |
| `scripting` | Run playlist reads/probes in the Twitch page context. |
| `tabs` | Clean up per-tab state when a tab closes. |
| `storage` | Settings and session state. |
| `https://www.twitch.tv/*` | The player page. |
| `https://*.cloudfront.net/*` | VOD playlists and segments. |
| `https://usher.ttvnw.net/*` | Master playlist / quality and codec information. |

No data is collected or sent anywhere by this extension.

## Tests

The test suite covers the pure playlist/quality logic, the real background
script driven with mocked WebExtension APIs, and a real headless Firefox run
against a local synthetic HLS server.

Node is not required to use the extension. If it is not installed locally, a
portable copy can be used for tests:

```sh
mkdir -p /tmp/opencode/tools
cd /tmp/opencode/tools
curl -fsSL -o node.tar.xz \
  https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz
tar -xf node.tar.xz
export PATH=/tmp/opencode/tools/node-v22.14.0-linux-x64/bin:$PATH
npm install --prefix /tmp/opencode/tools web-ext@8 --no-audit --no-fund
export PATH=/tmp/opencode/tools/node_modules/.bin:$PATH
```

From the repository root:

```sh
# Unit + integration tests (Node test runner; no browser required)
node --test tests/core.test.js tests/integration.test.js

# Static extension validation
web-ext lint --source-dir .

# Real Firefox smoke test (uses a local mock CDN)
python3 tests/browser_smoke.py
```

The smoke test proved that, in headless Firefox, available segments were
redirected before the player request reached the server and a purged segment
was left muted.

### What was not tested

- No authenticated, live Twitch VOD was used. The browser test uses a
  synthetic HLS playlist served from localhost.
- Twitch can change its CDN paths, playlist format, headers, or codec layout.
  When that happens, detection or probing may need updating.
- Live streams, ads, geo-blocked VODs, and subscriber-only VODs are out of
  scope.

## Provenance and legal note

The behavioral reference was the original Chrome Web Store extension
**Twitch VOD Unmute**, extension ID
`kjbnfiobdlebmfgeklpfjjhcjfpbnkhf`, version `1.2.1`, published by Evan99w /
Evan Williams. Its CRX was downloaded and unpacked solely to observe behavior;
the original source was **not** copied into this repository. The implementation
here is clean-room and independent. See [PROVENANCE.md](PROVENANCE.md) for the
artifact hash and details.

The original extension is closed-source and no license grant from its author
is assumed. This project does not reuse its code, icons, name assets, or
branding beyond the descriptive project name needed to explain what it
reproduces.

## License

This reimplementation is released under the [MIT License](LICENSE). That
license applies only to the code and documentation in this repository, not to
the original Chrome extension or to Twitch.
