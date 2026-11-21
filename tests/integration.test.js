'use strict';

/*
 * Drives the real background.js in a VM with mocked WebExtension APIs and a
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
const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000,CODECS="avc1.640028,mp4a.40.2"',
  'https://vod123.cloudfront.net/vod/12345/720p60/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.4D401F,mp4a.40.2"',
  'https://vod123.cloudfront.net/vod/12345/480p30/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="hvc1.1.6.L120,mp4a.40.2"',
  'https://vod123.cloudfront.net/vod/12345/360p30/index.m3u8'
].join('\n');
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
  injectDelay = 0,
  injectDelayFor = null
} = {}) {
  const listeners = {
    installed: [],
    beforeRequest: [],
    completed: [],
    removed: [],
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
  responses.set(PLAYLIST_URL, response(true, 200, PLAYLIST));

  for (let n = 0; n < 4; n++) {
    for (const quality of ['720p60', '480p30', '360p30']) {
      const url = Core.buildUnmutedUrl(PLAYLIST_URL, n + '-muted.ts', quality);
      const ok = (quality === '720p60' && available720.includes(n)) ||
        (quality === '480p30' && available480.includes(n));
      responses.set(url, response(ok, ok ? 200 : 404, ''));
    }
  }

  const fetchMock = async url => responses.get(url) || response(false, 404, '');

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
        const delay = injectDelayFor
          ? injectDelayFor((args || [])[0]) || 0
          : injectDelay;
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
      query: async () => [{ id: TAB_ID }]
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

  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'background.js' });

  return { listeners, sync, session, browser, context, allowLowerQuality, injectDelay };
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
    entry.filter.urls.some(url => url.includes('cloudfront.net')));
  assert.ok(usher && muted, 'network listeners registered');

  await usher.fn({ tabId: TAB_ID, url: MASTER_URL, type: 'xmlhttprequest' });
  await muted.fn({ tabId: TAB_ID, url: PLAYLIST_URL, type: 'xmlhttprequest' });
}

async function scan(harness) {
  await startScan(harness);
  await waitFor(() => harness.session.stats && harness.session.stats[TAB_ID]);
}

async function redirectFor(harness, segmentName) {
  const listener = harness.listeners.beforeRequest[0];
  const response = await listener.fn({
    tabId: TAB_ID,
    url: PLAYLIST_URL.replace(/[^/]*$/, segmentName),
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
    entry.filter.urls.some(url => url.includes('cloudfront.net')));
  await muted.fn({ tabId: TAB_ID, url: PLAYLIST_URL, type: 'xmlhttprequest' });
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.equal(vm.runInContext('queue.length', harness.context), 0);
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
