'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const MANIFEST_FILES = ['manifest.json', 'manifest.firefox.json', 'manifest.chrome.json'];
const BUILD_FILES = [
  'build-all.sh', ...MANIFEST_FILES,
  'popup.html', 'popup.css', 'popup.js',
  'background.js', 'background-chrome.js'
];

function makeBuildDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvu-bump-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of BUILD_FILES) {
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  for (const subdir of ['src', 'icons']) {
    fs.cpSync(path.join(root, subdir), path.join(dir, subdir), { recursive: true });
  }
  fs.chmodSync(path.join(dir, 'build-all.sh'), 0o755);
  return dir;
}

function runBuild(dir, args) {
  return execFileSync('./build-all.sh', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function versionIn(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).version;
}

function assertVersions(dir, expected) {
  for (const file of MANIFEST_FILES) {
    assert.equal(versionIn(dir, file), expected, file);
  }
}
const ff = JSON.parse(fs.readFileSync(path.join(root, 'manifest.firefox.json'), 'utf8'));
const chrome = JSON.parse(fs.readFileSync(path.join(root, 'manifest.chrome.json'), 'utf8'));

test('browser manifests stay on the same version', () => {
  assert.equal(ff.version, chrome.version);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version, ff.version);
});

test('store-facing names avoid browser trademarks', () => {
  for (const manifest of [ff, chrome]) {
    for (const field of ['name', 'description']) {
      assert.ok(!/\b(mozilla|firefox|chrome)\b/i.test(manifest[field]),
        `${field} contains a browser trademark: ${manifest[field]}`);
    }
    assert.ok(!/\b(mozilla|firefox|chrome)\b/i.test(manifest.action.default_title));
  }
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

test('--bump updates all three manifests and names artifacts with the new version', (t) => {
  const dir = makeBuildDir(t);
  assertVersions(dir, '1.0.0');

  runBuild(dir, ['--bump', 'patch', '--chrome', '--no-verify']);

  assertVersions(dir, '1.0.1');
  assert.ok(fs.existsSync(path.join(
    dir, 'web-ext-artifacts', 'twitch-vod-unmute-chrome-1.0.1.zip')));
});

test('--bump follows semantic version rules', (t) => {
  const dir = makeBuildDir(t);

  runBuild(dir, ['--bump', 'patch', '--chrome', '--no-verify']);
  assertVersions(dir, '1.0.1');

  runBuild(dir, ['--bump', 'minor', '--chrome', '--no-verify']);
  assertVersions(dir, '1.1.0');

  runBuild(dir, ['--bump', 'major', '--chrome', '--no-verify']);
  assertVersions(dir, '2.0.0');
  assert.ok(fs.existsSync(path.join(
    dir, 'web-ext-artifacts', 'twitch-vod-unmute-chrome-2.0.0.zip')));
});

test('--bump edits only the version line in each manifest', (t) => {
  const dir = makeBuildDir(t);
  const before = new Map(MANIFEST_FILES.map(file =>
    [file, fs.readFileSync(path.join(dir, file), 'utf8')]));

  runBuild(dir, ['--bump', 'patch', '--chrome', '--no-verify']);

  for (const file of MANIFEST_FILES) {
    const expected = before.get(file).replace('"version": "1.0.0"', '"version": "1.0.1"');
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), expected, file);
  }
});

test('--bump rejects invalid or conflicting options without editing manifests', (t) => {
  const dir = makeBuildDir(t);

  assert.throws(() => runBuild(dir, ['--bump', 'foo', '--chrome', '--no-verify']));
  assertVersions(dir, '1.0.0');

  assert.throws(() => runBuild(dir, ['--bump']));
  assertVersions(dir, '1.0.0');

  assert.throws(() => runBuild(dir, ['--bump', 'patch', '--verify-xpi', 'missing.xpi']));
  assertVersions(dir, '1.0.0');
});

test('--bump refuses inconsistent manifest versions', (t) => {
  const dir = makeBuildDir(t);
  const file = path.join(dir, 'manifest.chrome.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.version = '9.9.9';
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');

  assert.throws(() => runBuild(dir, ['--bump', 'patch', '--chrome', '--no-verify']));

  assert.equal(versionIn(dir, 'manifest.json'), '1.0.0');
  assert.equal(versionIn(dir, 'manifest.firefox.json'), '1.0.0');
  assert.equal(versionIn(dir, 'manifest.chrome.json'), '9.9.9');
});
