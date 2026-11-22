'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/core.js');

const PLAYLIST_URL =
  'https://vod123.cloudfront.net/vod/12345/720p60/index-muted-ABC123.m3u8';

test('isMutedPlaylistUrl matches only muted media playlists', () => {
  assert.equal(Core.isMutedPlaylistUrl(PLAYLIST_URL), true);
  assert.equal(Core.isMutedPlaylistUrl('https://x.cloudfront.net/v/1/index-muted-A1.m3u8?token=1'), true);
  assert.equal(Core.isMutedPlaylistUrl('https://x.cloudfront.net/v/1/index.m3u8'), false);
  assert.equal(Core.isMutedPlaylistUrl('not a url'), false);
});

test('VOD gates distinguish CDN VOD paths, VOD pages and live paths', () => {
  assert.equal(Core.isVodUrl(PLAYLIST_URL), true);
  assert.equal(Core.isVodUrl('https://live.cloudfront.net/live/chan/index-muted-A1.m3u8'), false);
  assert.equal(Core.isVodMutedPlaylistUrl(PLAYLIST_URL), true);
  assert.equal(
    Core.isVodMutedPlaylistUrl('https://live.cloudfront.net/live/chan/index-muted-A1.m3u8'),
    false);
  assert.equal(Core.isVodPageUrl('https://www.twitch.tv/videos/2936135145'), true);
  assert.equal(Core.isVodPageUrl('https://www.twitch.tv/alanzoka/video/2936135145'), true);
  assert.equal(Core.isVodPageUrl('https://www.twitch.tv/alanzoka'), false);
  assert.equal(Core.playlistKey(PLAYLIST_URL + '?token=one'), Core.playlistKey(PLAYLIST_URL + '?token=two'));
});

test('parseMasterPlaylist extracts qualities and base codecs', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.640028,mp4a.40.2"',
    'https://x.cloudfront.net/v/1/1080p60/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=500,CODECS="avc1.4D401F,mp4a.40.2"',
    'https://x.cloudfront.net/v/1/720p60/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="hvc1.1.6.L120,mp4a.40.2"',
    'https://x.cloudfront.net/v/1/360p30/index.m3u8'
  ].join('\n');

  const parsed = Core.parseMasterPlaylist(text);
  assert.deepEqual(parsed.qualities, ['1080p60', '720p60', '360p30']);
  assert.deepEqual(parsed.codecMap, {
    '1080p60': 'avc1',
    '720p60': 'avc1',
    '360p30': 'hvc1'
  });
});

test('parseMutedPlaylist reads segment numbers and the last segment index', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '0.ts',
    '1-muted.ts',
    '2-muted.ts',
    '3.ts?token=abc',
    '4-muted.mp4'
  ].join('\n');

  const parsed = Core.parseMutedPlaylist(text);
  assert.equal(parsed.lastNumber, 4);
  assert.deepEqual(parsed.segments, [
    { number: 1, name: '1-muted.ts' },
    { number: 2, name: '2-muted.ts' },
    { number: 4, name: '4-muted.mp4' }
  ]);
});

test('unmutedName only strips the trailing -muted marker', () => {
  assert.equal(Core.unmutedName('12-muted.ts'), '12.ts');
  assert.equal(Core.unmutedName('12-muted.mp4'), '12.mp4');
  assert.equal(Core.unmutedName('12-mutedmix.ts'), '12-mutedmix.ts');
});

test('unmutedNameCandidates prefers -unmuted and keeps the plain name as fallback', () => {
  assert.deepEqual(Core.unmutedNameCandidates('12-muted.ts'),
    ['12-unmuted.ts', '12.ts']);
  assert.deepEqual(Core.unmutedNameCandidates('12-muted.mp4'),
    ['12-unmuted.mp4', '12.mp4']);
  assert.deepEqual(Core.unmutedNameCandidates('12.ts'), ['12.ts']);
});

test('dvrPlaylistUrl derives the unmuted sibling playlist', () => {
  assert.equal(
    Core.dvrPlaylistUrl(PLAYLIST_URL + '?token=x'),
    'https://vod123.cloudfront.net/vod/12345/720p60/index-dvr.m3u8'
  );
  assert.equal(
    Core.dvrPlaylistUrl(PLAYLIST_URL + '?token=x', true),
    'https://vod123.cloudfront.net/vod/12345/720p60/index-dvr.m3u8?token=x'
  );
});

test('parseUnmutedPlaylist maps segment numbers to exact filenames', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '0-unmuted.ts',
    '1.ts',
    '2-unmuted.mp4?token=abc',
    'https://cdn.example/3-unmuted.ts'
  ].join('\n');

  assert.deepEqual(Core.parseUnmutedPlaylist(text), {
    '0': '0-unmuted.ts',
    '2': '2-unmuted.mp4',
    '3': '3-unmuted.ts'
  });
  assert.deepEqual(Core.parseUnmutedPlaylist(null), {});
});

test('buildUnmutedUrl replaces the quality directory and drops the query', () => {
  assert.equal(
    Core.buildUnmutedUrl(PLAYLIST_URL + '?token=x', '7-muted.ts', '480p30'),
    'https://vod123.cloudfront.net/vod/12345/480p30/7.ts'
  );
});

test('buildUnmutedUrl accepts an exact unmuted filename', () => {
  assert.equal(
    Core.buildUnmutedUrl(PLAYLIST_URL + '?token=x', '7-muted.ts', '480p30', '7-unmuted.ts'),
    'https://vod123.cloudfront.net/vod/12345/480p30/7-unmuted.ts'
  );
});

test('qualitiesToTry respects codec compatibility and the lower-quality option', () => {
  const qualities = ['1080p60', '720p60', '480p30', '360p30'];
  const codecMap = {
    '1080p60': 'avc1', '720p60': 'avc1', '480p30': 'avc1', '360p30': 'hvc1'
  };

  assert.deepEqual(Core.qualitiesToTry(qualities, codecMap, '720p60', false),
    ['720p60', '1080p60']);
  assert.deepEqual(Core.qualitiesToTry(qualities, codecMap, '720p60', true),
    ['720p60', '1080p60', '480p30']);
  assert.deepEqual(Core.qualitiesToTry(qualities, {}, '720p60', true),
    ['720p60', '1080p60', '480p30', '360p30']);
  assert.deepEqual(Core.qualitiesToTry(qualities, {}, 'chunked', false),
    ['chunked', '1080p60', '720p60', '480p30', '360p30']);
});

test('qualitiesToTry also checks compatible higher qualities from a low current quality', () => {
  const qualities = ['1080p60', '720p60', '480p30', '360p30', '160p30'];
  const codecMap = Object.fromEntries(qualities.map(quality => [quality, 'avc1']));

  assert.deepEqual(Core.qualitiesToTry(qualities, codecMap, '360p30', false),
    ['360p30', '1080p60', '720p60', '480p30']);
  assert.deepEqual(Core.qualitiesToTry(qualities, codecMap, '360p30', true),
    ['360p30', '1080p60', '720p60', '480p30', '160p30']);
});

test('buildSeekbarBands groups contiguous segments and includes the last one', () => {
  const results = [
    { number: 0, quality: '720p60' },
    { number: 1, quality: '720p60' },
    { number: 2, quality: '480p30' },
    { number: 3, quality: '480p30' },
    { number: 4, quality: null }
  ];

  assert.deepEqual(Core.buildSeekbarBands(results, 4), [
    { left: 0, width: 40, quality: '720p60' },
    { left: 40, width: 40, quality: '480p30' },
    { left: 80, width: 20, quality: null }
  ]);
  assert.deepEqual(Core.buildSeekbarBands([], 4), []);
  assert.deepEqual(Core.buildSeekbarBands([{ number: 0, quality: '720p60' }], 0), [
    { left: 0, width: 100, quality: '720p60' }
  ]);
});

test('withOpacity appends a clamped alpha channel', () => {
  assert.equal(Core.withOpacity('#00ff00', 0.5), '#00FF0080');
  assert.equal(Core.withOpacity('ff0000', 2), '#FF0000FF');
  assert.equal(Core.withOpacity('nope', 0), '#00000000');
});

test('normaliseSettings fills in missing defaults', () => {
  assert.deepEqual(Core.normaliseSettings({ enabled: false }), {
    ...Core.DEFAULT_SETTINGS,
    enabled: false
  });
});

test('isAvailable accepts 200 and 206 only', () => {
  assert.equal(Core.isAvailable(200), true);
  assert.equal(Core.isAvailable(206), true);
  assert.equal(Core.isAvailable(403), false);
  assert.equal(Core.isAvailable(undefined), false);
});
