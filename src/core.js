/*
 * Pure shared logic for the Firefox and Chrome builds of Twitch VOD Unmute.
 *
 * This file intentionally contains no WebExtension API calls so it can be
 * unit-tested directly with Node. It is written from scratch based on the
 * observable behaviour of the original Chrome extension (see README).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TVUCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_QUALITIES = [
    'chunked', '1080p60', '720p60', '480p30', '360p30', '160p30'
  ];

  const DEFAULT_SETTINGS = {
    enabled: true,
    seekbar: true,
    quality: true,
    unmutedColour: '#00FF00',
    qualityColour: '#FFA500',
    mutedColour: '#FF0000',
    opacity: 0.5
  };

  const MUTED_PLAYLIST_RE = /index-muted-[A-Z0-9]+\.m3u8$/i;
  const SEGMENT_FILE_RE = /^\d+(?:-muted)?\.(?:ts|mp4)$/i;
  const MUTED_SEGMENT_RE = /^(\d+)-muted\.(ts|mp4)$/i;

  /** True when a URL points at a Twitch "muted" media playlist. */
  function isMutedPlaylistUrl(url) {
    let pathname;
    try {
      pathname = new URL(url).pathname;
    } catch (_) {
      pathname = String(url).split('?')[0].split('#')[0];
    }
    return MUTED_PLAYLIST_RE.test(pathname.split('/').pop());
  }

  /** True when a URL is inside a Twitch VOD path (`/vod/<id>/...`). */
  function isVodUrl(url) {
    let pathname;
    try {
      pathname = new URL(url).pathname;
    } catch (_) {
      pathname = String(url).split('?')[0].split('#')[0];
    }
    return /\/vod\/\d+(?:\/|$)/.test(pathname);
  }

  /**
   * True only for muted playlists that belong to a VOD.
   *
   * Live HLS playlists can also be named `index-muted-*.m3u8`. The extension
   * must never probe or delay live traffic, so the VOD path is mandatory.
   */
  function isVodMutedPlaylistUrl(url) {
    return isVodUrl(url) && isMutedPlaylistUrl(url);
  }

  /**
   * Extract the VOD id from a top-level Twitch page URL.
   *
   * Twitch uses both path-based VOD pages (`/videos/<id>`,
   * `/<channel>/video/<id>`) and the standalone player, which keeps the id in
   * the `video` query parameter. Both must count as VOD context; otherwise a
   * popout player is incorrectly treated as a live stream.
   */
  function vodIdFromUrl(url) {
    let pathname;
    let videoParam = '';

    try {
      const parsed = new URL(url);
      if (!/(^|\.)twitch\.tv$/i.test(parsed.hostname)) return null;
      pathname = parsed.pathname;
      videoParam = parsed.searchParams.get('video') || '';
    } catch (_) {
      const text = String(url);
      pathname = text.split('?')[0].split('#')[0];
      const match = /(?:^|[?&])video=([^&#]*)/i.exec(text);
      videoParam = match ? match[1] : '';
    }

    const pathMatch =
      /(?:^|\/)videos\/(\d+)(?:\/|$)|(?:^|\/)video\/(\d+)(?:\/|$)/.exec(pathname);
    if (pathMatch) return pathMatch[1] || pathMatch[2];

    try {
      videoParam = decodeURIComponent(videoParam);
    } catch (_) {
      /* keep the raw value */
    }
    const videoMatch = /(?:vod:)?(\d+)/i.exec(videoParam);
    return videoMatch ? videoMatch[1] : null;
  }

  /** True for a top-level Twitch page that is showing a VOD. */
  function isVodPageUrl(url) {
    return vodIdFromUrl(url) !== null;
  }

  /**
   * True only for URLs that explicitly indicate a live stream.
   *
   * Navigation to an unknown or transitional Twitch URL must not be labelled
   * "live" in the popup; it should only clear stale VOD state.
   */
  function isLivePageUrl(url) {
    let pathname;
    let hasChannel = false;
    let hasVideo = false;

    try {
      const parsed = new URL(url);
      if (!/(^|\.)twitch\.tv$/i.test(parsed.hostname)) return false;
      pathname = parsed.pathname;
      hasChannel = parsed.searchParams.has('channel');
      hasVideo = parsed.searchParams.has('video');
    } catch (_) {
      const text = String(url);
      pathname = text.split('?')[0].split('#')[0];
      hasChannel = /(?:^|[?&])channel=/i.test(text);
      hasVideo = /(?:^|[?&])video=/i.test(text);
    }

    if (vodIdFromUrl(url)) return false;
    if (hasChannel && !hasVideo) return true;
    return /^\/live(?:[\/?]|$)/.test(pathname);
  }

  /** Stable key for a playlist, ignoring player tokens in the query string. */
  function playlistKey(url) {
    try {
      const parsed = new URL(url);
      return parsed.origin + parsed.pathname;
    } catch (_) {
      return String(url).split('?')[0].split('#')[0];
    }
  }

  /** Extract quality labels and their base codec from a master playlist. */
  function parseMasterPlaylist(text) {
    const qualities = [];
    const codecMap = {};
    const lines = String(text == null ? '' : text).split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

      const variant = (lines[i + 1] || '').trim();
      if (!variant || !/\.m3u8(?:[?#]|$)/i.test(variant)) continue;

      let quality = null;
      try {
        const parts = new URL(variant, 'https://example.invalid/').pathname.split('/');
        quality = parts[parts.length - 2] || parts[parts.length - 1].replace(/\.m3u8$/i, '');
      } catch (_) {
        continue;
      }
      if (!quality) continue;

      if (!qualities.includes(quality)) qualities.push(quality);

      const codecMatch = line.match(/CODECS="([^"]+)"/i);
      if (codecMatch) {
        codecMap[quality] = codecMatch[1].split(',')[0].split('.')[0];
      } else if (!(quality in codecMap)) {
        codecMap[quality] = null;
      }
    }

    return { qualities, codecMap };
  }

  /**
   * Read a muted media playlist and return its muted segments plus the index
   * of the final segment (used to convert segment numbers into percentages).
   */
  function parseMutedPlaylist(text) {
    const segments = [];
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    let lastNumber = 0;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      const file = line.split('?')[0].split('#')[0].split('/').pop();
      const plain = file.match(/^(\d+)\.(?:ts|mp4)$/i);
      const muted = file.match(MUTED_SEGMENT_RE);
      if (plain) {
        lastNumber = Math.max(lastNumber, parseInt(plain[1], 10));
      } else if (muted) {
        const number = parseInt(muted[1], 10);
        lastNumber = Math.max(lastNumber, number);
        segments.push({ number, name: file });
      }
    }

    return { segments, lastNumber };
  }

  /** Turn "12-muted.ts" into "12.ts". */
  function unmutedName(name) {
    return String(name).replace(/-muted(\.(?:ts|mp4))$/i, '$1');
  }

  /**
   * Candidate filenames for the unmuted original of a muted segment.
   *
   * Twitch commonly keeps recoverable originals as "12-unmuted.ts" or
   * "12-unmuted.mp4", not as the plain "12.ts"/"12.mp4" name. The plain name is
   * still tried as a fallback for older VODs.
   */
  function unmutedNameCandidates(name) {
    const match = /^(\d+)-muted\.(ts|mp4)$/i.exec(String(name));
    if (!match) {
      const plain = unmutedName(name);
      return plain === String(name) ? [String(name)] : [plain];
    }
    return [
      match[1] + '-unmuted.' + match[2],
      match[1] + '.' + match[2]
    ];
  }

  /**
   * Build the unmuted sibling playlist URL for a muted media playlist.
   *
   * Some CDN setups require the player's token on `index-dvr.m3u8` too, so the
   * caller can request a copy with the original query string preserved.
   */
  function dvrPlaylistUrl(playlistUrl, keepQuery) {
    const url = new URL(playlistUrl);
    url.pathname = url.pathname.replace(/[^/]*$/, 'index-dvr.m3u8');
    url.hash = '';
    if (!keepQuery) url.search = '';
    return url.href;
  }

  /**
   * Read exact unmuted filenames from an index-dvr.m3u8 playlist.
   * Returns a map of segment number -> filename.
   */
  function parseUnmutedPlaylist(text) {
    const names = {};
    const lines = String(text == null ? '' : text).split(/\r?\n/);

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      const file = line.split('?')[0].split('#')[0].split('/').pop();
      const match = /^(\d+)-unmuted\.(ts|mp4)$/i.exec(file);
      if (match) names[match[1]] = file;
    }

    return names;
  }

  /** Build the unmuted segment URL for a given quality directory. */
  function buildUnmutedUrl(playlistUrl, mutedName, quality, unmutedFileName) {
    const url = new URL(playlistUrl);
    const parts = url.pathname.split('/');
    if (parts.length >= 2) {
      parts[parts.length - 2] = quality;
    } else {
      parts.unshift(quality);
    }
    parts[parts.length - 1] = unmutedFileName || unmutedName(mutedName);
    url.pathname = parts.join('/');
    url.search = '';
    url.hash = '';
    return url.href;
  }

  /**
   * Qualities to probe for an unmuted original.
   *
   * Twitch only publishes unmuted originals for some qualities. A player can
   * select a low quality (especially in Firefox), so limiting the search to
   * the current quality and *lower* qualities can miss every available copy.
   * Try the current quality first, then any compatible higher qualities, and
   * finally lower qualities when the user allows them. When codec data is
   * missing (common for "chunked"), we still try the whole ladder with the
   * current quality first.
   */
  function qualitiesToTry(qualities, codecMap, current, allowLower) {
    const ladder = Array.isArray(qualities) && qualities.length
      ? qualities
      : DEFAULT_QUALITIES;
    const codec = codecMap && codecMap[current];
    if (!codec) {
      // Twitch does not always advertise the "chunked" variant (or its codec)
      // in the master playlist. Trying only the current quality then recovers
      // almost nothing, so fall back to the whole ladder with it first.
      return Array.from(new Set([current, ...ladder]));
    }

    const start = ladder.indexOf(current);
    const higher = [];
    const lower = [];
    for (let i = 0; i < ladder.length; i++) {
      if (i === start) continue;
      const q = ladder[i];
      if (q !== current && codecMap[q] !== codec) continue;
      if (start !== -1 && i > start) lower.push(q);
      else higher.push(q);
    }

    const result = [current, ...higher];
    if (allowLower) result.push(...lower);
    return Array.from(new Set(result));
  }

  /** Group consecutive segments with the same quality into seekbar bands. */
  function buildSeekbarBands(results, lastNumber) {
    if (!Array.isArray(results) || !results.length ||
        typeof lastNumber !== 'number' || lastNumber < 0) return [];

    // Twitch numbers media segments from 0, so the final index is not the
    // segment count. Using lastNumber directly would overflow the seekbar.
    const total = lastNumber + 1;
    const ordered = results.slice().sort((a, b) => a.number - b.number);
    const bands = [];
    let first = ordered[0];
    let count = 1;

    for (let i = 1; i <= ordered.length; i++) {
      const next = ordered[i];
      const continuous = next && next.number === first.number + count &&
        next.quality === first.quality;

      if (continuous) {
        count++;
        continue;
      }

      const end = ordered[i - 1].number;
      bands.push({
        left: (first.number / total) * 100,
        width: ((end - first.number + 1) / total) * 100,
        quality: first.quality
      });

      if (next) {
        first = next;
        count = 1;
      }
    }

    return bands;
  }

  /** Append an alpha channel (as two hex digits) to a #RRGGBB colour. */
  function withOpacity(hex, opacity) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex == null ? '' : hex).trim());
    const colour = match ? match[1].toUpperCase() : '000000';
    let value = Number(opacity);
    if (!Number.isFinite(value)) value = DEFAULT_SETTINGS.opacity;
    value = Math.round(Math.min(1, Math.max(0, value)) * 255);
    return '#' + colour + value.toString(16).padStart(2, '0').toUpperCase();
  }

  /** Normalise settings loaded from storage. */
  function normaliseSettings(items) {
    const source = items || {};
    const settings = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      settings[key] = source[key] === undefined ? DEFAULT_SETTINGS[key] : source[key];
    }
    return settings;
  }

  /** Decide whether a probe status means the original is available. */
  function isAvailable(status) {
    return status === 200 || status === 206;
  }

  return {
    DEFAULT_QUALITIES,
    DEFAULT_SETTINGS,
    isMutedPlaylistUrl,
    isVodUrl,
    isVodMutedPlaylistUrl,
    isVodPageUrl,
    isLivePageUrl,
    vodIdFromUrl,
    playlistKey,
    parseMasterPlaylist,
    parseMutedPlaylist,
    unmutedName,
    unmutedNameCandidates,
    dvrPlaylistUrl,
    parseUnmutedPlaylist,
    buildUnmutedUrl,
    qualitiesToTry,
    buildSeekbarBands,
    withOpacity,
    normaliseSettings,
    isAvailable
  };
});
