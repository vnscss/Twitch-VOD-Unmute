# Provenance

This repository is an independent, clean-room **reimplementation** of a
Chrome Web Store extension. It was created with AI assistance (OpenCode).

## Reference artifact

| Field | Value |
| --- | --- |
| Product | Twitch VOD Unmute |
| Store | Chrome Web Store |
| Extension ID | `kjbnfiobdlebmfgeklpfjjhcjfpbnkhf` |
| Version observed | `1.2.1` |
| Publisher | Evan99w / Evan Williams |
| Publisher email listed on the store | `evan99w.dev@gmail.com` |
| Publisher GitHub listed on the store | `https://github.com/Evan99w` (no public repos/gists found) |
| Download endpoint used | `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&x=id%3Dkjbnfiobdlebmfgeklpfjjhcjfpbnkhf%26uc&prodversion=120.0.0.0` |
| CRX SHA-256 | `23ae51d29bc3b9a87ac834393879c382c8267455029bd5219c19866bd9eb2cf9` |
| CRX size | 14,890 bytes |

The CRX3 was unpacked into a temporary directory outside the repository. Its
`manifest.json`, `background.js`, `popup.html`, `popup.js`, and `popup.css` were
read to understand observable behavior only.

## What was reused

No source code, icon files, or other assets from the original extension were
copied into this repository. The Firefox implementation was written from
scratch, including:

- a new pure playlist/quality module (`src/core.js`)
- a new Firefox background script using `webRequest` blocking redirects
- a new local popup UI and stylesheet
- new icons generated for this repository
- new tests and documentation

## Behavior reproduced

- detect muted media playlists named `index-muted-*.m3u8`
- parse muted media playlists and derive unmuted segment URLs
- probe unmuted segments from the page context
- redirect available segments
- optionally fall back to a codec-compatible lower quality
- colour the seekbar for recovered / lower-quality / still-muted ranges
- preserve the original settings model and defaults

## Legal status

The original extension is closed-source and no license grant from its author
was found or assumed. The MIT license in this repository covers only the new
code and documentation written for this Firefox reimplementation.
