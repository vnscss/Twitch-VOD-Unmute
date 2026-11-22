'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ff = JSON.parse(fs.readFileSync(path.join(root, 'manifest.firefox.json'), 'utf8'));
const chrome = JSON.parse(fs.readFileSync(path.join(root, 'manifest.chrome.json'), 'utf8'));

test('browser manifests stay on the same version', () => {
  assert.equal(ff.version, chrome.version);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version, ff.version);
});

test('Firefox target keeps blocking webRequest', () => {
  assert.ok(ff.browser_specific_settings.gecko.id);
  assert.equal(ff.browser_specific_settings.gecko.strict_min_version, '140.0');
  assert.equal(
    ff.browser_specific_settings.gecko_android.strict_min_version, '142.0');
  assert.deepEqual(
    ff.browser_specific_settings.gecko.data_collection_permissions.required,
    ['none']);
  assert.ok(ff.background.scripts.includes('src/background-core.js'));
  assert.ok(ff.background.scripts.includes('background.js'));
  assert.ok(!ff.background.scripts.includes('background-chrome.js'));
  assert.ok(ff.permissions.includes('webRequestBlocking'));
});

test('Chrome target uses MV3 service worker and declarativeNetRequest', () => {
  assert.equal(chrome.browser_specific_settings, undefined);
  assert.equal(chrome.background.service_worker, 'background-chrome.js');
  assert.ok(chrome.permissions.includes('declarativeNetRequest'));
  assert.ok(!chrome.permissions.includes('webRequestBlocking'));
  assert.ok(chrome.host_permissions.includes('https://*.cloudfront.net/*'));
});

test('build script is executable and exposes signing flags', () => {
  const file = path.join(root, 'build-all.sh');
  assert.ok(fs.statSync(file).mode & 0o111, 'build-all.sh must be executable');
  const source = fs.readFileSync(file, 'utf8');
  for (const flag of ['--firefox', '--chrome', '--sign', '--crx', '--out', '--verify-xpi']) {
    assert.ok(source.includes(flag), 'missing flag: ' + flag);
  }
});

test('shared runtime scripts referenced by both targets exist', () => {
  for (const file of [
    'src/core.js',
    'src/api.js',
    'src/background-core.js',
    'background.js',
    'background-chrome.js',
    'popup.html',
    'popup.js'
  ]) {
    assert.ok(fs.existsSync(path.join(root, file)), 'missing ' + file);
  }
});
