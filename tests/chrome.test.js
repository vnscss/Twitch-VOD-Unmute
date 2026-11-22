'use strict';

/*
 * Drives the Chrome service worker adapter with mocked chrome.* APIs.
 * The important difference from Firefox is that redirects become
 * declarativeNetRequest rules instead of blocking webRequest responses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../src/core.js');

const TAB_ID = 7;
const PLAYLIST_URL =
  'https://vod123.cloudfront.net/vod/12345/720p60/index-muted-ABC123.m3u8';
const DVR_URL = 'https://vod123.cloudfront.net/vod/12345/720p60/index-dvr.m3u8';
const LIVE_PLAYLIST_URL =
  'https://live123.cloudfront.net/live/alanzoka/index-muted-LIVE.m3u8';
const VOD_POPOUT_URL =
  'https://player.twitch.tv/?enableExtensions=true&muted=false&parent=twitch.tv' +
  '&player=popout&quality=1080p60&t=0h19m58s&video=2936135145&volume=1';
const PLAYLIST = ['#EXTM3U', '0-muted.ts', '1-muted.ts', '2-muted.ts'].join('\n');
const DVR = ['#EXTM3U', '0-unmuted.ts', '1.ts', '2-unmuted.ts'].join('\n');

function pick(store, keys) {
  const wanted = typeof keys === 'string' ? [keys] : (keys || Object.keys(store));
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
  pageUrl = null,
  playlistUrlOverride = null,
  allForbidden = false,
  playlistText = PLAYLIST
} = {}) {
  const playlistUrl = playlistUrlOverride || PLAYLIST_URL;
  const listeners = {
    installed: [],
    completed: [],
    removed: [],
    updated: [],
    message: [],
    changed: []
  };
  const sync = {};
  const session = {};
  const dnrCalls = [];
  let sessionRules = [];

  function response(ok, status, text) {
    return {
      ok,
      status,
      text: async () => text,
      headers: { get: () => null },
      body: { cancel: async () => {} }
    };
  }

  const dvrUrl = Core.dvrPlaylistUrl(playlistUrl);
  const responses = new Map([
    [playlistUrl, response(true, 200, playlistText)],
    [dvrUrl, response(true, 200, DVR)]
  ]);
  for (let n = 0; n < 8; n++) {
    const plain = Core.buildUnmutedUrl(playlistUrl, n + '-muted.ts', '720p60');
    responses.set(plain, response(n !== 1, n === 1 ? 404 : 200, ''));
    if (n !== 1) {
      const exact = Core.buildUnmutedUrl(
        playlistUrl, n + '-muted.ts', '720p60', n + '-unmuted.ts');
      responses.set(exact, response(true, 200, ''));
    }
  }

  const fetchMock = async (url, options) => {
    if (allForbidden && options && options.headers && options.headers.Range) {
      return response(false, 403, '');
    }
    return responses.get(url) || response(false, 404, '');
  };

  const chrome = {
    storage: {
      sync: {
        get: (keys, cb) => cb(pick(sync, keys)),
        set: (values, cb) => { Object.assign(sync, values); cb(); }
      },
      session: {
        get: (keys, cb) => cb(pick(session, keys)),
        set: (values, cb) => { Object.assign(session, values); cb(); }
      },
      onChanged: {
        addListener: fn => listeners.changed.push(fn)
      }
    },
    scripting: {
      executeScript: (details, cb) => {
        Promise.resolve(details.func(...(details.args || [])))
          .then(result => cb([{ result }]), error => cb([{ error: String(error) }]));
      }
    },
    webRequest: {
      onCompleted: {
        addListener: (fn, filter) => listeners.completed.push({ fn, filter })
      }
    },
    runtime: {
      lastError: undefined,
      onInstalled: { addListener: fn => listeners.installed.push(fn) },
      onMessage: { addListener: fn => listeners.message.push(fn) },
      sendMessage: (message, cb) => cb({ stats: null })
    },
    tabs: {
      onRemoved: { addListener: fn => listeners.removed.push(fn) },
      onUpdated: { addListener: fn => listeners.updated.push(fn) },
      query: (info, cb) => cb([{ id: TAB_ID, url: pageUrl || undefined }])
    },
    declarativeNetRequest: {
      getSessionRules: async () => sessionRules.slice(),
      updateSessionRules: async (details) => {
        dnrCalls.push(details);
        const removed = new Set(details.removeRuleIds || []);
        sessionRules = sessionRules.filter(rule => !removed.has(rule.id));
        sessionRules.push(...(details.addRules || []));
      }
    }
  };

  const context = vm.createContext({
    chrome,
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
    Map,
    RegExp,
    Error
  });

  for (const file of [
    'src/core.js',
    'src/api.js',
    'src/background-core.js',
    'background-chrome.js'
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }

  return { listeners, sync, session, chrome, dnrCalls, playlistUrl,
    getSessionRules: () => sessionRules };
}

async function statsFor(harness) {
  return new Promise((resolve, reject) => {
    harness.listeners.message[0]({ type: 'tvu:stats', tabId: TAB_ID }, {}, response => {
      if (response && response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

async function startScan(harness) {
  for (const fn of harness.listeners.installed) await fn({ reason: 'install' });
  await harness.chrome.storage.sync.set({ seekbar: false, quality: false }, () => {});

  const muted = harness.listeners.completed.find(entry =>
    entry.filter.urls.includes('https://*.twitch.tv/*'));
  assert.ok(muted, 'muted playlist listener registered');
  await muted.fn({ tabId: TAB_ID, url: harness.playlistUrl, type: 'xmlhttprequest' });
  await waitFor(() => harness.session.stats && harness.session.stats[TAB_ID]);
}

test('Chrome adapter creates scoped DNR redirect rules', async () => {
  const harness = createHarness();
  assert.equal(harness.chrome.webRequest.onBeforeRequest, undefined,
    'Chrome build must not register a blocking listener');

  await startScan(harness);

  assert.ok(harness.session.dnrRules[TAB_ID],
    'session-scoped DNR rule IDs are tracked for the tab');

  const expected0 = Core.buildUnmutedUrl(
    PLAYLIST_URL, '0-muted.ts', '720p60', '0-unmuted.ts');
  const expected2 = Core.buildUnmutedUrl(
    PLAYLIST_URL, '2-muted.ts', '720p60', '2-unmuted.ts');
  const rules = harness.getSessionRules();

  const rule0 = rules.find(rule => rule.action.redirect.url === expected0);
  const rule2 = rules.find(rule => rule.action.redirect.url === expected2);
  assert.ok(rule0 && rule2, 'both available segments have redirect rules');

  const key0 = 'https://vod123.cloudfront.net/vod/12345/720p60/0-muted.ts';
  assert.ok(rule0.condition.regexFilter.includes('0-muted\\.ts'));
  assert.equal(rule0.condition.regexFilter.startsWith('^' + key0.slice(0, 8)), true);
  assert.deepEqual(JSON.parse(JSON.stringify(rule0.condition.tabIds)), [TAB_ID]);
  assert.deepEqual(JSON.parse(JSON.stringify(rule0.condition.resourceTypes)),
    ['xmlhttprequest', 'media', 'other']);

  assert.ok(!rules.some(rule => rule.action.redirect.url.includes('1-muted')),
    'unavailable segment has no redirect rule');

  const stats = await statsFor(harness);
  assert.equal(stats.stats.restored, 2);
  assert.equal(stats.stats.dvrRestored, 2);
});

test('a real vod-secure playlist generates scoped DNR rules', async () => {
  const harness = createHarness({
    playlistUrlOverride:
      'https://vod-secure.twitch.tv/8f6ba87341845cda3e48_alanzoka_34721465552_1238758894/' +
      '720p60/index-muted-A1B2-C3_D4.m3u8',
    pageUrl: VOD_POPOUT_URL
  });
  await startScan(harness);

  const rules = harness.getSessionRules();
  const expected = Core.buildUnmutedUrl(
    harness.playlistUrl, '0-muted.ts', '720p60', '0-unmuted.ts');
  assert.ok(rules.some(rule => rule.action.redirect.url === expected),
    'real VOD playlist produces redirect rules');
  const stats = await statsFor(harness);
  assert.equal(stats.stats.restored, 2);
  assert.equal(stats.diagnostics.mode, 'vod');
});

test('unpublished unmuted originals create no DNR rules', async () => {
  const harness = createHarness({
    allForbidden: true,
    playlistText: ['#EXTM3U', '0-muted.ts', '1-muted.ts', '2-muted.ts',
      '3-muted.ts', '4-muted.ts', '5-muted.ts', '6-muted.ts'].join('\n')
  });
  await startScan(harness);

  assert.equal(harness.getSessionRules().length, 0);
  const stats = await statsFor(harness);
  assert.equal(stats.stats.restored, 0);
  assert.equal(stats.stats.probeStatus, 'forbidden');
  assert.equal(stats.stats.truncated, true);
  assert.equal(stats.diagnostics.reason, 'unmuted originals not published yet');
});

test('closing a tab removes only that tab DNR rules', async () => {
  const harness = createHarness();
  await startScan(harness);

  const ids = harness.getSessionRules().map(rule => rule.id);
  assert.equal(ids.length, 2);
  await harness.listeners.removed[0](TAB_ID);

  assert.equal(harness.getSessionRules().length, 0);
  const removal = harness.dnrCalls[harness.dnrCalls.length - 1];
  assert.deepEqual(removal.removeRuleIds.slice().sort((a, b) => a - b),
    ids.slice().sort((a, b) => a - b));
});

test('disabling the extension clears DNR rules', async () => {
  const harness = createHarness();
  await startScan(harness);
  assert.ok(harness.getSessionRules().length > 0);

  await harness.chrome.storage.sync.set({ enabled: false }, () => {});
  for (const fn of harness.listeners.changed) {
    fn({ enabled: { newValue: false } }, 'sync');
  }
  await waitFor(() => harness.getSessionRules().length === 0);

  assert.equal(harness.getSessionRules().length, 0);
});

test('Chrome ignores live playlists and creates no DNR rules', async () => {
  const harness = createHarness({ pageUrl: 'https://www.twitch.tv/live' });
  for (const fn of harness.listeners.installed) await fn({ reason: 'install' });

  const muted = harness.listeners.completed.find(entry =>
    entry.filter.urls.includes('https://*.twitch.tv/*'));
  await muted.fn({ tabId: TAB_ID, url: LIVE_PLAYLIST_URL, type: 'xmlhttprequest' });
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.equal(harness.getSessionRules().length, 0);
  assert.equal(harness.session.stats && harness.session.stats[TAB_ID], undefined);
  assert.equal(harness.session['diagnostics:' + TAB_ID].mode, 'live');
});

test('navigating from a VOD to a live channel removes its DNR rules', async () => {
  const harness = createHarness();
  await startScan(harness);
  assert.ok(harness.getSessionRules().length > 0);

  assert.equal(harness.listeners.updated.length, 1);
  for (const fn of harness.listeners.updated) {
    await fn(TAB_ID, { url: 'https://www.twitch.tv/somechannel' });
  }

  assert.equal(harness.getSessionRules().length, 0);
  const stats = await statsFor(harness);
  assert.equal(stats.stats, null);
});

test('a player popout for the same VOD keeps its DNR rules', async () => {
  const harness = createHarness();
  await startScan(harness);
  const before = harness.getSessionRules().length;
  assert.ok(before > 0);

  for (const fn of harness.listeners.updated) {
    await fn(TAB_ID, { url: VOD_POPOUT_URL });
  }

  assert.equal(harness.getSessionRules().length, before);
  const stats = await statsFor(harness);
  assert.equal(stats.stats.restored, 2);
  assert.equal(stats.diagnostics.mode, 'vod');
});
