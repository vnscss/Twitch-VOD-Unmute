'use strict';

/*
 * Drives the real shared background core in a VM with mocked WebExtension APIs and a
 * synthetic HLS playlist. This checks the full detection -> probe -> redirect
 * pipeline without needing a live Twitch VOD.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../src/core.js');

const TAB_ID = 7;
const MASTER_URL = 'https://usher.ttvnw.net/vod/12345?token=abc';
const PLAYLIST_URL =
  'https://vod123.cloudfront.net/vod/12345/720p60/index-muted-ABC123.m3u8';
const DVR_URL = 'https://vod123.cloudfront.net/vod/12345/720p60/index-dvr.m3u8';
const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000,CODECS="avc1.640028,mp4a.40.2"',
  'https://vod123.cloudfront.net/vod/12345/720p60/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.4D401F,mp4a.40.2"',
  'https://vod123.cloudfront.net/vod/12345/480p30/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="hvc1.1.6.L120,mp4a.40.2"',
  'https://vod123.cloudfront.net/vod/12345/360p30/index.m3u8'
].join('\n');
const VOD_PAGE_URL = 'https://www.twitch.tv/videos/2936135145';
const VOD_POPOUT_URL =
  'https://player.twitch.tv/?enableExtensions=true&muted=false&parent=twitch.tv' +
  '&player=popout&quality=1080p60&t=0h19m58s&video=2936135145&volume=1';
const LIVE_PLAYLIST_URL =
  'https://live123.cloudfront.net/live/alanzoka/index-muted-LIVE.m3u8';
const LIVE_SEGMENT_URL =
  'https://live123.cloudfront.net/live/alanzoka/12-muted.ts';
const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:10',
  '0-muted.ts',
  '1-muted.ts',
  '2-muted.ts',
  '3-muted.ts'
].join('\n');

function pick(store, keys) {
  const wanted = typeof keys === 'string' ? [keys] : keys;
  const result = {};
  for (const key of wanted) {
    if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
  }
  return result;
}

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function createHarness({
  allowLowerQuality = false,
  available720 = [0, 2],
  available480 = [1],
  availableDvr = [],
  dvrPlaylist = false,
  injectDelay = 0,
  injectDelayFor = null,
  dvrDelay = 0,
  playlistToken = '',
  dvrRequiresToken = false,
  pageUrl = null,
  playlistUrlOverride = null
} = {}) {
  const playlistUrl = (playlistUrlOverride || PLAYLIST_URL) + playlistToken;
  const dvrPlainUrl = Core.dvrPlaylistUrl(playlistUrl);
  const dvrTokenUrl = Core.dvrPlaylistUrl(playlistUrl, true);
  const listeners = {
    installed: [],
    beforeRequest: [],
    completed: [],
    removed: [],
    updated: [],
    message: [],
    changed: []
  };
  const sync = {};
  const session = {};

  const responses = new Map();
  function response(ok, status, text) {
    return {
      ok,
      status,
      text: async () => text,
      headers: { get: () => null },
      body: { cancel: async () => {} }
    };
  }

  responses.set(MASTER_URL, response(true, 200, MASTER));
  responses.set(playlistUrl, response(true, 200, PLAYLIST));

  if (dvrPlaylist || availableDvr.length) {
    const dvrLines = ['#EXTM3U', '#EXT-X-TARGETDURATION:10'];
    for (let n = 0; n < 4; n++) {
      dvrLines.push(availableDvr.includes(n) ? n + '-unmuted.ts' : n + '.ts');
    }
    if (!dvrRequiresToken) responses.set(dvrPlainUrl, response(true, 200, dvrLines.join('\n')));
    if (dvrRequiresToken || dvrTokenUrl !== dvrPlainUrl) {
      responses.set(dvrTokenUrl, response(true, 200, dvrLines.join('\n')));
    }
  }

  for (let n = 0; n < 4; n++) {
    for (const quality of ['720p60', '480p30', '360p30']) {
      const url = Core.buildUnmutedUrl(playlistUrl, n + '-muted.ts', quality);
      const ok = (quality === '720p60' && available720.includes(n)) ||
        (quality === '480p30' && available480.includes(n));
      responses.set(url, response(ok, ok ? 200 : 404, ''));

      if (quality === '720p60' && availableDvr.includes(n)) {
        const exactUrl = Core.buildUnmutedUrl(
          playlistUrl, n + '-muted.ts', quality, n + '-unmuted.ts');
        responses.set(exactUrl, response(true, 200, ''));
      }
    }
  }

  const probeCalls = [];
  const fetchMock = async (url, options) => {
    if (options && options.headers && options.headers.Range) {
      probeCalls.push({ url, options });
    }
    return responses.get(url) || response(false, 404, '');
  };

  const browser = {
    storage: {
      sync: {
        get: async keys => pick(sync, keys),
        set: async values => Object.assign(sync, values)
      },
      session: {
        get: async keys => pick(session, keys),
        set: async values => Object.assign(session, values)
      },
      onChanged: { addListener: fn => listeners.changed.push(fn) }
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        const firstArg = (args || [])[0];
        let delay = injectDelayFor ? injectDelayFor(firstArg) || 0 : injectDelay;
        if (!delay && dvrDelay && firstArg === dvrTokenUrl) delay = dvrDelay;
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        try {
          return [{ result: await func(...(args || [])) }];
        } catch (error) {
          return [{ error: String(error && error.message || error) }];
        }
      }
    },
    webRequest: {
      onBeforeRequest: {
        addListener: (fn, filter, extra) => listeners.beforeRequest.push({ fn, filter, extra })
      },
      onCompleted: {
        addListener: (fn, filter) => listeners.completed.push({ fn, filter })
      }
    },
    runtime: {
      onInstalled: { addListener: fn => listeners.installed.push(fn) },
      onMessage: { addListener: fn => listeners.message.push(fn) }
    },
    tabs: {
      onRemoved: { addListener: fn => listeners.removed.push(fn) },
      onUpdated: { addListener: fn => listeners.updated.push(fn) },
      query: async () => [{ id: TAB_ID, url: pageUrl || undefined }]
    }
  };

  const context = vm.createContext({
    browser,
    TVUCore: Core,
    fetch: fetchMock,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    Promise,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    JSON,
    Set,
    Error
  });

  for (const file of ['src/background-core.js', 'background.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }

  return { listeners, sync, session, browser, context, probeCalls,
    allowLowerQuality, injectDelay, playlistUrl, dvrPlainUrl, dvrTokenUrl };
}

async function startScan(harness) {
  for (const fn of harness.listeners.installed) await fn({ reason: 'install' });
  await harness.browser.storage.sync.set({
    seekbar: false,
    quality: harness.allowLowerQuality
  });

  const usher = harness.listeners.completed.find(entry =>
    entry.filter.urls.some(url => url.includes('usher.ttvnw.net')));
  const muted = harness.listeners.completed.find(entry =>
    entry.filter.urls.includes('https://*.twitch.tv/*'));
  assert.ok(usher && muted, 'network listeners registered');

  await usher.fn({ tabId: TAB_ID, url: MASTER_URL, type: 'xmlhttprequest' });
  await muted.fn({ tabId: TAB_ID, url: harness.playlistUrl, type: 'xmlhttprequest' });
}

async function scan(harness) {
  await startScan(harness);
  await waitFor(() => harness.session.stats && harness.session.stats[TAB_ID]);
}

async function redirectFor(harness, segmentName, query = '') {
  const listener = harness.listeners.beforeRequest[0];
  const response = await listener.fn({
    tabId: TAB_ID,
    url: harness.playlistUrl.replace(/[^/]*$/, segmentName) + query,
    type: 'xmlhttprequest'
  });
  // The response comes from the VM realm, so compare plain values.
  return JSON.parse(JSON.stringify(response || {}));
}

test('redirects available segments and leaves purged ones muted', async () => {
  const harness = createHarness();
  await scan(harness);

  assert.deepEqual(await redirectFor(harness, '0-muted.ts'), {
    redirectUrl: Core.buildUnmutedUrl(PLAYLIST_URL, '0-muted.ts', '720p60')
  });
  assert.deepEqual(await redirectFor(harness, '2-muted.ts'), {
    redirectUrl: Core.buildUnmutedUrl(PLAYLIST_URL, '2-muted.ts', '720p60')
  });
  assert.deepEqual(await redirectFor(harness, '3-muted.ts'), {});

  const stats = await harness.listeners.message[0]({ type: 'tvu:stats', tabId: TAB_ID });
  assert.equal(stats.stats.total, 4);
  assert.equal(stats.stats.restored, 2);
  assert.equal(stats.stats.lowerQuality, 0);
  assert.equal(stats.stats.dvrRestored, 0);
});

test('uses exact unmuted filenames from the DVR playlist', async () => {
  const harness = createHarness({ available720: [0, 2], availableDvr: [0, 2] });
  await scan(harness);

  const exactUrl = Core.buildUnmutedUrl(
    PLAYLIST_URL, '0-muted.ts', '720p60', '0-unmuted.ts');
  assert.deepEqual(await redirectFor(harness, '0-muted.ts'), {
    redirectUrl: exactUrl
  });
  assert.deepEqual(await redirectFor(harness, '2-muted.ts'), {
    redirectUrl: Core.buildUnmutedUrl(
      PLAYLIST_URL, '2-muted.ts', '720p60', '2-unmuted.ts')
  });
  assert.deepEqual(await redirectFor(harness, '3-muted.ts'), {});

  const stats = await harness.listeners.message[0]({ type: 'tvu:stats', tabId: TAB_ID });
  assert.equal(stats.stats.restored, 2);
  assert.equal(stats.stats.dvrRestored, 2);
});

test('falls back to plain filenames when the DVR playlist is missing', async () => {
  const harness = createHarness();
  await scan(harness);

  assert.deepEqual(await redirectFor(harness, '0-muted.ts'), {
    redirectUrl: Core.buildUnmutedUrl(PLAYLIST_URL, '0-muted.ts', '720p60')
  });
  assert.equal(harness.session.redirects[
    'https://vod123.cloudfront.net/vod/12345/720p60/0-muted.ts'
  ].endsWith('/0.ts'), true);
});

test('probes with only the Range header', async () => {
  const harness = createHarness();
  await scan(harness);

  assert.ok(harness.probeCalls.length > 0, 'probe requests were recorded');
  for (const call of harness.probeCalls) {
    assert.deepEqual(Object.keys(call.options).sort(), ['headers', 'signal']);
    assert.deepEqual(JSON.parse(JSON.stringify(call.options.headers)),
      { Range: 'bytes=0-1' });
    assert.equal(Object.prototype.hasOwnProperty.call(call.options, 'cache'), false);
  }
});

test('redirects segment requests that carry query tokens', async () => {
  const harness = createHarness();
  await scan(harness);

  assert.deepEqual(await redirectFor(harness, '0-muted.ts', '?token=abc'), {
    redirectUrl: Core.buildUnmutedUrl(PLAYLIST_URL, '0-muted.ts', '720p60')
  });
});

test('observes every supported CDN host', async () => {
  const harness = createHarness();
  const cdnListeners = [harness.listeners.beforeRequest[0],
    ...harness.listeners.completed].filter(entry =>
    entry.filter.urls.includes('https://*.cloudfront.net/*'));
  assert.equal(cdnListeners.length, 2);
  for (const entry of cdnListeners) {
    for (const pattern of ['https://*.cloudfront.net/*', 'https://*.ttvnw.net/*',
      'https://*.akamaized.net/*', 'https://*.twitch.tv/*']) {
      assert.ok(entry.filter.urls.includes(pattern), 'missing filter: ' + pattern);
    }
  }
});

test('does not cache failed probes as purged segments', async () => {
  const harness = createHarness();
  await scan(harness);

  const cached = harness.session.probes || {};
  const unavailable = Core.buildUnmutedUrl(PLAYLIST_URL, '3-muted.ts', '720p60');
  assert.equal(Object.prototype.hasOwnProperty.call(cached, unavailable), false);
});

test('holds segment requests until the scan finishes', async () => {
  const harness = createHarness({ injectDelay: 80 });
  await startScan(harness);

  const listener = harness.listeners.beforeRequest[0].fn;
  let settled = false;
  const request = listener({
    tabId: TAB_ID,
    url: PLAYLIST_URL.replace(/[^/]*$/, '0-muted.ts'),
    type: 'xmlhttprequest'
  }).then(response => {
    settled = true;
    return JSON.parse(JSON.stringify(response || {}));
  });

  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(settled, false, 'segment request should wait for probing');

  await waitFor(() => harness.session.stats && harness.session.stats[TAB_ID]);
  assert.deepEqual(await request, {
    redirectUrl: Core.buildUnmutedUrl(PLAYLIST_URL, '0-muted.ts', '720p60')
  });
});

test('does not hold ordinary (already unmuted) segment requests', async () => {
  const harness = createHarness({ injectDelayFor: () => 200 });
  await startScan(harness);

  const started = Date.now();
  const result = await harness.listeners.beforeRequest[0].fn({
    tabId: TAB_ID,
    url: PLAYLIST_URL.replace(/[^/]*$/, '0.ts'),
    type: 'media'
  });
  assert.ok(Date.now() - started < 50, 'unmuted segments must not be delayed');
  assert.deepEqual(JSON.parse(JSON.stringify(result || {})), {});
});

test('releases each muted segment as soon as it is checked', async () => {
  const harness = createHarness({
    // Probes request the *unmuted* file name, so match /3.ts, not /3-muted.ts.
    injectDelayFor: url => String(url).includes('/3.ts') ? 300 : 5
  });
  await startScan(harness);

  const listener = harness.listeners.beforeRequest[0].fn;
  let firstSettled = false;
  let lastSettled = false;
  const first = listener({
    tabId: TAB_ID,
    url: PLAYLIST_URL.replace(/[^/]*$/, '0-muted.ts'),
    type: 'media'
  }).then(response => {
    firstSettled = true;
    return JSON.parse(JSON.stringify(response || {}));
  });
  const last = listener({
    tabId: TAB_ID,
    url: PLAYLIST_URL.replace(/[^/]*$/, '3-muted.ts'),
    type: 'media'
  }).then(response => {
    lastSettled = true;
    return JSON.parse(JSON.stringify(response || {}));
  });

  await waitFor(() => firstSettled, 500);
  assert.equal(lastSettled, false, 'a different segment should still be waiting');

  assert.deepEqual(await first, {
    redirectUrl: Core.buildUnmutedUrl(PLAYLIST_URL, '0-muted.ts', '720p60')
  });
  assert.deepEqual(await last, {});
});

test('ignores the playlist read generated by the extension itself', async () => {
  const harness = createHarness();
  await scan(harness);

  const muted = harness.listeners.completed.find(entry =>
    entry.filter.urls.includes('https://*.twitch.tv/*'));
  await muted.fn({ tabId: TAB_ID, url: PLAYLIST_URL, type: 'xmlhttprequest' });
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.equal(vm.runInContext('TVUInstance.queue.length', harness.context), 0);
});

test('falls back to a codec-compatible lower quality when allowed', async () => {
  const harness = createHarness({ allowLowerQuality: true });
  await scan(harness);

  assert.deepEqual(await redirectFor(harness, '1-muted.ts'), {
    redirectUrl: Core.buildUnmutedUrl(PLAYLIST_URL, '1-muted.ts', '480p30')
  });

  const stats = await harness.listeners.message[0]({ type: 'tvu:stats', tabId: TAB_ID });
  assert.equal(stats.stats.restored, 3);
  assert.equal(stats.stats.lowerQuality, 1);
});

test('disabling the extension clears every redirect', async () => {
  const harness = createHarness();
  await scan(harness);
  assert.notDeepEqual(await redirectFor(harness, '0-muted.ts'), {});

  await harness.browser.storage.sync.set({ enabled: false });
  for (const fn of harness.listeners.changed) {
    await fn({ enabled: { newValue: false } }, 'sync');
  }

  assert.deepEqual(await redirectFor(harness, '0-muted.ts'), {});
});

test('closing the tab removes its redirects and stats', async () => {
  const harness = createHarness();
  await scan(harness);

  for (const fn of harness.listeners.removed) await fn(TAB_ID);

  assert.deepEqual(await redirectFor(harness, '0-muted.ts'), {});
  const stats = await harness.listeners.message[0]({ type: 'tvu:stats', tabId: TAB_ID });
  assert.equal(stats.stats, null);
});

test('the popup clear button empties stored state', async () => {
  const harness = createHarness();
  await scan(harness);

  const answer = await harness.listeners.message[0]({ type: 'tvu:stats', clear: true });
  assert.equal(answer.stats, null);
  assert.deepEqual(await redirectFor(harness, '0-muted.ts'), {});
});

test('live playlists and live segments are completely ignored', async () => {
  const harness = createHarness({ pageUrl: 'https://www.twitch.tv/live' });
  for (const fn of harness.listeners.installed) await fn({ reason: 'install' });

  const muted = harness.listeners.completed.find(entry =>
    entry.filter.urls.includes('https://*.twitch.tv/*'));
  await muted.fn({ tabId: TAB_ID, url: LIVE_PLAYLIST_URL, type: 'xmlhttprequest' });
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.equal(vm.runInContext('TVUInstance.queue.length', harness.context), 0);
  assert.equal(harness.probeCalls.length, 0);
  assert.equal(harness.session.stats && harness.session.stats[TAB_ID], undefined);
  assert.equal(harness.session['diagnostics:' + TAB_ID].mode, 'live');

  const started = Date.now();
  const result = await harness.listeners.beforeRequest[0].fn({
    tabId: TAB_ID,
    url: LIVE_SEGMENT_URL,
    type: 'media'
  });
  assert.ok(Date.now() - started < 50, 'live segments must not be held');
  assert.deepEqual(JSON.parse(JSON.stringify(result || {})), {});
});

test('a muted segment with no active VOD scan returns immediately', async () => {
  const harness = createHarness();
  for (const fn of harness.listeners.installed) await fn({ reason: 'install' });

  const started = Date.now();
  const result = await harness.listeners.beforeRequest[0].fn({
    tabId: TAB_ID,
    url: PLAYLIST_URL.replace(/[^/]*$/, '0-muted.ts'),
    type: 'media'
  });
  assert.ok(Date.now() - started < 50, 'no scan means no wait');
  assert.deepEqual(JSON.parse(JSON.stringify(result || {})), {});
});

test('different player tokens do not start duplicate scans', async () => {
  const harness = createHarness();
  await scan(harness);
  const before = harness.probeCalls.length;

  const muted = harness.listeners.completed.find(entry =>
    entry.filter.urls.includes('https://*.twitch.tv/*'));
  await muted.fn({
    tabId: TAB_ID,
    url: harness.playlistUrl + '?token=rotated',
    type: 'xmlhttprequest'
  });
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.equal(harness.probeCalls.length, before);
  assert.equal(vm.runInContext('TVUInstance.queue.length', harness.context), 0);
});

test('DVR filenames are exhausted before plain-name probes', async () => {
  const harness = createHarness({ availableDvr: [0, 2] });
  await scan(harness);

  assert.ok(harness.probeCalls.some(call => call.url.endsWith('/0-unmuted.ts')));
  assert.ok(!harness.probeCalls.some(call => call.url.endsWith('/0.ts')),
    'plain fallback must not be probed when the DVR name works');
  const stats = await harness.listeners.message[0]({ type: 'tvu:stats', tabId: TAB_ID });
  assert.equal(stats.stats.dvrStatus, 'ok');
  assert.equal(stats.stats.dvrNames, 2);
});

test('a token-protected DVR playlist is used as a fallback', async () => {
  const harness = createHarness({
    playlistToken: '?token=player',
    dvrRequiresToken: true,
    availableDvr: [0]
  });
  await scan(harness);

  assert.deepEqual(await redirectFor(harness, '0-muted.ts'), {
    redirectUrl: Core.buildUnmutedUrl(
      harness.playlistUrl, '0-muted.ts', '720p60', '0-unmuted.ts')
  });
  const stats = await harness.listeners.message[0]({ type: 'tvu:stats', tabId: TAB_ID });
  assert.equal(stats.stats.dvrStatus, 'ok');
  assert.equal(stats.stats.dvrRequests, 2);
});

test('a delayed DVR playlist still restores exact segments', async () => {
  const harness = createHarness({ availableDvr: [0, 2], dvrDelay: 150 });
  await startScan(harness);

  let settled = false;
  const request = harness.listeners.beforeRequest[0].fn({
    tabId: TAB_ID,
    url: harness.playlistUrl.replace(/[^/]*$/, '0-muted.ts'),
    type: 'media'
  }).then(response => {
    settled = true;
    return JSON.parse(JSON.stringify(response || {}));
  });

  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(settled, false, 'the VOD request should wait for the slow DVR read');
  await waitFor(() => harness.session.stats && harness.session.stats[TAB_ID]);

  assert.deepEqual(await request, {
    redirectUrl: Core.buildUnmutedUrl(
      harness.playlistUrl, '0-muted.ts', '720p60', '0-unmuted.ts')
  });
  const stats = await harness.listeners.message[0]({ type: 'tvu:stats', tabId: TAB_ID });
  assert.equal(stats.stats.dvrRestored, 2);
  assert.ok(stats.stats.waitedSegments >= 1);
});

test('navigating away from a VOD clears its VOD state', async () => {
  const harness = createHarness();
  await scan(harness);
  assert.notDeepEqual(await redirectFor(harness, '0-muted.ts'), {});

  assert.equal(harness.listeners.updated.length, 1);
  for (const fn of harness.listeners.updated) {
    await fn(TAB_ID, { url: 'https://www.twitch.tv/live' });
  }

  assert.deepEqual(await redirectFor(harness, '0-muted.ts'), {});
  const answer = await harness.listeners.message[0]({
    type: 'tvu:stats', tabId: TAB_ID
  });
  assert.equal(answer.stats, null);
  assert.equal(answer.diagnostics.mode, 'live');
  assert.equal(vm.runInContext('TVUInstance.activeScans.size', harness.context), 0);
});

test('opening a VOD page replaces a stale live diagnostic', async () => {
  const harness = createHarness();
  for (const fn of harness.listeners.installed) await fn({ reason: 'install' });

  const updated = harness.listeners.updated[0];
  await updated(TAB_ID, { url: 'https://www.twitch.tv/live' });
  let answer = await harness.listeners.message[0]({
    type: 'tvu:stats', tabId: TAB_ID
  });
  assert.equal(answer.diagnostics.mode, 'live');

  await updated(TAB_ID, { url: VOD_PAGE_URL });
  answer = await harness.listeners.message[0]({
    type: 'tvu:stats', tabId: TAB_ID
  });
  assert.equal(answer.stats, null);
  assert.equal(answer.diagnostics.mode, 'vod');
  assert.equal(answer.diagnostics.reason, 'VOD page');
  assert.equal(answer.diagnostics.vodId, '2936135145');
});

test('a player popout for the same VOD keeps the existing scan state', async () => {
  const harness = createHarness();
  await scan(harness);

  const updated = harness.listeners.updated[0];
  await updated(TAB_ID, { url: VOD_PAGE_URL });
  await updated(TAB_ID, { url: VOD_POPOUT_URL });

  assert.notDeepEqual(await redirectFor(harness, '0-muted.ts'), {});
  const answer = await harness.listeners.message[0]({
    type: 'tvu:stats', tabId: TAB_ID
  });
  assert.equal(answer.stats.restored, 2);
  assert.equal(answer.diagnostics.mode, 'vod');
  assert.equal(answer.diagnostics.vodId, '2936135145');
});

test('an ambiguous navigation is not reported as a live stream', async () => {
  const harness = createHarness();
  for (const fn of harness.listeners.installed) await fn({ reason: 'install' });

  const updated = harness.listeners.updated[0];
  await updated(TAB_ID, { url: VOD_PAGE_URL });
  await updated(TAB_ID, { url: 'https://www.twitch.tv/' });

  const answer = await harness.listeners.message[0]({
    type: 'tvu:stats', tabId: TAB_ID
  });
  assert.equal(answer.diagnostics.mode, 'unknown');
  assert.equal(answer.diagnostics.reason, 'navigated outside VOD');
});

test('a real vod-secure playlist without /vod/ is scanned and redirected', async () => {
  const realPlaylist =
    'https://vod-secure.twitch.tv/8f6ba87341845cda3e48_alanzoka_34721465552_1238758894/' +
    '720p60/index-muted-A1B2-C3_D4.m3u8';
  const harness = createHarness({ playlistUrlOverride: realPlaylist });
  await scan(harness);

  assert.notDeepEqual(await redirectFor(harness, '0-muted.ts'), {});
  const answer = await harness.listeners.message[0]({
    type: 'tvu:stats', tabId: TAB_ID
  });
  assert.equal(answer.stats.total, 4);
  assert.equal(answer.stats.restored, 2);
  assert.notEqual(answer.diagnostics.mode, 'live');
});

test('a real VOD playlist on a popout keeps VOD diagnostics', async () => {
  const realPlaylist =
    'https://vod-secure.twitch.tv/8f6ba87341845cda3e48_alanzoka_34721465552_1238758894/' +
    '720p60/index-muted-A1B2-C3_D4.m3u8';
  const harness = createHarness({
    playlistUrlOverride: realPlaylist,
    pageUrl: VOD_POPOUT_URL
  });
  await scan(harness);

  const answer = await harness.listeners.message[0]({
    type: 'tvu:stats', tabId: TAB_ID
  });
  assert.equal(answer.diagnostics.mode, 'vod');
  assert.notEqual(answer.diagnostics.mode, 'live');
});

test('an intermediate about:blank navigation does not clear VOD state', async () => {
  const harness = createHarness();
  await scan(harness);

  await harness.listeners.updated[0](TAB_ID, { url: 'about:blank' });
  assert.notDeepEqual(await redirectFor(harness, '0-muted.ts'), {});
  const answer = await harness.listeners.message[0]({
    type: 'tvu:stats', tabId: TAB_ID
  });
  assert.equal(answer.stats.restored, 2);
  assert.equal(answer.diagnostics.mode, 'vod');
});

test('switching to a different VOD clears the old VOD state', async () => {
  const harness = createHarness();
  await scan(harness);

  const updated = harness.listeners.updated[0];
  await updated(TAB_ID, { url: VOD_PAGE_URL });
  await updated(TAB_ID, { url: 'https://www.twitch.tv/videos/999' });

  assert.deepEqual(await redirectFor(harness, '0-muted.ts'), {});
  const answer = await harness.listeners.message[0]({
    type: 'tvu:stats', tabId: TAB_ID
  });
  assert.equal(answer.stats, null);
  assert.equal(answer.diagnostics.vodId, '999');
});
