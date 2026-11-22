# Twitch VOD Unmute (Firefox port + Chrome export)

> **This project is a reimplementation.** It is not the original Chrome
> extension, and it is not published by, affiliated with, or endorsed by the
> original author.
>
> **This repository was made with AI assistance** (OpenCode). The code, tests,
> and documentation were generated and reviewed with AI help.

Manifest V3 extensions that restore audio to muted Twitch VODs when Twitch
still serves the original (unmuted) media segments on its CDN. The repository
ships a Firefox target and a functional Chrome target built from the same
playlist/probe core. The
`index-dvr.m3u8` / `-unmuted` recovery approach is public, community-documented
Twitch HLS behavior; sources are listed in
[Credits and acknowledgments](#credits-and-acknowledgments).

## What it does

When Twitch serves a muted VOD playlist, this extension:

1. Detects the `index-muted-*.m3u8` media playlist.
2. Reads the playlist and finds the muted `.ts`/`.mp4` segments.
3. Reads the sibling `index-dvr.m3u8` playlist to learn the exact unmuted
   filenames Twitch currently serves (for example `12-unmuted.mp4`).
4. Probes those exact filenames first, then the legacy plain `12.mp4` name,
   in the current quality, any codec-compatible higher qualities, and finally
   lower qualities when enabled.
5. Holds the player's segment requests until probing finishes.
6. Redirects only the requests whose original segment is still available.
7. Optionally colours the seekbar to show which parts were recovered.

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

### Build packages

`build-all.sh` stages clean target directories and exports both browsers by
default. It requires `python3`, `zip`, `unzip`, and `web-ext` on `PATH`.

```sh
./build-all.sh                 # Firefox XPI + Chrome Web Store ZIP
./build-all.sh --firefox       # Firefox XPI only
./build-all.sh --chrome        # Chrome ZIP only
./build-all.sh --out DIR       # change the output directory
```

Outputs:

```text
web-ext-artifacts/twitch-vod-unmute-firefox-<version>.xpi
web-ext-artifacts/twitch-vod-unmute-chrome-<version>.zip
```

`build-xpi.sh` remains as a Firefox-only wrapper. Firefox 140 or newer is
required on desktop and Firefox for Android 142 or newer; this matches the
manifest data-collection declaration required by current `web-ext`.

### Verify or sign the Firefox XPI

The build script verifies the archive structure, manifest fields, absence of
development files, and (when present) Mozilla signature metadata. An existing
XPI can be checked directly:

```sh
./build-all.sh --verify-xpi web-ext-artifacts/twitch-vod-unmute-firefox-1.0.0.xpi
```

A local unsigned XPI works with **Load Temporary Add-on**, Developer Edition,
Nightly, or ESR with signature checks disabled. Release and Beta Firefox will
not install it permanently. To get a self-distributed signed XPI, use AMO's
unlisted channel:

```sh
export WEB_EXT_API_KEY='...'
export WEB_EXT_API_SECRET='...'
./build-all.sh --firefox --sign
```

`--sign` verifies that the result contains `META-INF/mozilla.rsa`,
`META-INF/mozilla.sf`, and `META-INF/manifest.mf`. Each signed version needs a
new version number and the same add-on ID. Never commit the AMO credentials.

### Chrome target

The Chrome ZIP has `manifest.json` at the archive root, as required by the
Chrome Web Store. Unzip it and use **Load unpacked** at `chrome://extensions`,
or upload the ZIP directly to the store.

Chrome MV3 does not allow the Firefox blocking `webRequest` redirect path, so
the Chrome target uses a service worker and session-scoped
`declarativeNetRequest` rules scoped to the originating tab. The playlist parsing, DVR filename lookup, probing,
seekbar painting, and popup settings are shared with Firefox through
`src/core.js`, `src/background-core.js`, and `src/api.js`.

A local CRX can also be produced, but it needs a stable PEM key:

```sh
CHROME_KEY=/path/to/twitch-vod-unmute.pem ./build-all.sh --crx
```

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
| **Allow lower-quality segments** | Also tries lower qualities after compatible higher qualities fail. |
| **Recovered / Lower quality / Still muted** | Seekbar colours. |
| **Opacity** | Alpha applied to the seekbar colours. |

Seekbar colours: green = recovered at the selected quality, orange = recovered
from a compatible lower quality, red = still muted.

## How it works

The original Chrome extension used `declarativeNetRequest` rules and injected
page scripts to probe Twitch's CDN. Both targets here share that approach at
the playlist/probe layer. The Firefox-specific pieces are:

- `webRequest.onCompleted` to observe playlist requests.
- `webRequest.onBeforeRequest` with `blocking` to redirect segment requests.
- `browser.scripting.executeScript` in the page's `MAIN` world to read
  playlists and probe unmuted segments with CORS-compatible requests.
- Redirect keys ignore query strings/tokens on segment requests. Exact
unmuted filenames are read from `index-dvr.m3u8` before falling back to the
legacy plain filenames. Unmuted originals are not available for every quality,
so codec-compatible higher qualities are checked even when the player selected
a low quality. If the master playlist does not describe the selected quality
(common for `chunked`), the whole ladder is tried with that quality first.
- Probes send only `Range: bytes=0-1`. Extra cache headers can make Twitch's
CDN reject an otherwise available segment with 403.
- `browser.storage.sync` for settings and `browser.storage.session` for
  per-session redirects, positive probe results, and statistics.

Only muted segment requests are held, and only until that individual segment
has been checked. Already-unmuted segments are never delayed. The extension's
own playlist reads are ignored to avoid rescanning its own traffic.

## Permissions

| Permission | Why |
| --- | --- |
| `webRequest`, `webRequestBlocking` | Observe playlists and redirect segment requests. |
| `scripting` | Run playlist reads/probes in the Twitch page context. |
| `tabs` | Clean up per-tab state when a tab closes. |
| `storage` | Settings and session state. |
| `https://*.twitch.tv/*` | The player page and Twitch-hosted media. |
| `https://*.cloudfront.net/*` | VOD playlists and segments (CloudFront VOD cluster). |
| `https://*.ttvnw.net/*` | VOD/live playlists and segments on Twitch's own CDN hosts. |
| `https://*.akamaized.net/*` | VOD playlists and segments on the Akamai VOD cluster. |

No data is collected or sent anywhere by this extension.

## Tests

The test suite covers the pure playlist/quality logic, both browser adapters
driven with mocked WebExtension APIs, build-target manifests, and a real
headless Firefox run against a local synthetic HLS server.

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
# Unit + integration + build-target tests (no browser required)
node --test tests/core.test.js tests/integration.test.js tests/seekbar.test.js \
  tests/build.test.js tests/chrome.test.js

# Static extension validation and dual export
./build-all.sh --strict-lint

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

## Credits and acknowledgments

The original behavioral reference was the Chrome Web Store extension
**Twitch VOD Unmute** by Evan99w / Evan Williams, extension ID
`kjbnfiobdlebmfgeklpfjjhcjfpbnkhf`, version `1.2.1`. Details about the observed
artifact are in [PROVENANCE.md](PROVENANCE.md). This project is an independent
reimplementation; no original code or assets were copied.

The DVR playlist recovery technique is public prior art, not a discovery unique
to this repository. It has been documented or used by:

- [twitch-hls-vods](https://github.com/fonsleenaars/twitch-hls-vods) — early
  documentation of Twitch VOD HLS playlists, including `index-dvr.m3u8`.
- [TwitchRecover issue #5](https://github.com/TwitchRecover/TwitchRecover/issues/5)
  and [PR #6](https://github.com/TwitchRecover/TwitchRecover/pull/6/files) —
  reports `-unmuted.ts` entries in DVR playlists and rewrites them for playback.
- [TwitchDownloader issue #182](https://github.com/lay295/TwitchDownloader/issues/182)
  — suggests replacing `index-muted-*.m3u8` with `index-dvr.m3u8`;
  [issue #1309](https://github.com/lay295/TwitchDownloader/issues/1309) —
  discusses unmuted segment availability and cross-quality fallback; and
  [issue #1315](https://github.com/lay295/TwitchDownloader/issues/1315) —
  reports unmuted renames causing old segment URLs to return 403.
- [twitch-dlp](https://github.com/DmitryScaletta/twitch-dlp) — implements
  automatic unmuting of muted sections.

These projects and discussions are credited as public documentation and prior
art only. No code from them was copied, and no affiliation or endorsement is
implied. This implementation was made with AI assistance (OpenCode), as noted
above and in the commit trailers.

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
