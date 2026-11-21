#!/usr/bin/env python3
"""Real-Firefox smoke test for the Twitch VOD Unmute Firefox port.

Builds a temporary copy of the extension with localhost added to its host
permissions, serves a synthetic muted HLS playlist, launches headless Firefox
through web-ext, and verifies that the extension redirected the player's
muted segment requests to the available originals.

Requires Node + web-ext on PATH (see README for the portable setup).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAYLIST = '\n'.join([
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '0-muted.ts',
    '1-muted.ts',
    '2-muted.ts',
])

PAGE = '''<!doctype html>
<html><head><meta charset="utf-8"><title>TVU smoke</title></head>
<body>
<p id="result">running</p>
<script>
(async () => {
  // Give web-ext a moment to finish loading the background script.
  await new Promise(resolve => setTimeout(resolve, 1200));
  const playlist = location.origin + '/vod/12345/720p60/index-muted-ABC.m3u8';
  try {
    await fetch(playlist, { cache: 'no-store' });
    for (const name of ['0-muted.ts', '1-muted.ts', '2-muted.ts']) {
      await fetch(playlist.replace(/[^/]*$/, name), { cache: 'no-store' });
    }
    document.getElementById('result').textContent = 'done';
  } catch (error) {
    document.getElementById('result').textContent = 'error: ' + error;
  }
})();
</script>
</body></html>
'''


class Handler(BaseHTTPRequestHandler):
    request_log = []
    lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def do_OPTIONS(self):
        # Twitch's CDN allows Range from the page; mimic that for probes.
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        # Probes send Range: bytes=0-1; real player segment requests do not.
        entry = (self.path, self.headers.get('Range'))
        with Handler.lock:
            Handler.request_log.append(entry)

        if self.path == '/':
            body = PAGE.encode()
            content_type = 'text/html'
            status = 200
        elif self.path == '/vod/12345/720p60/index-muted-ABC.m3u8':
            body = PLAYLIST.encode()
            content_type = 'application/vnd.apple.mpegurl'
            status = 200
        elif self.path.endswith('.ts'):
            name = self.path.rsplit('/', 1)[-1]
            # 0 and 2 still have originals on the CDN; 1 was purged.
            available = name in ('0-muted.ts', '2-muted.ts', '0.ts', '2.ts')
            body = b'tvufixture' if available else b''
            content_type = 'video/mp2t'
            status = 200 if available else 404
        else:
            body = b''
            content_type = 'text/plain'
            status = 404

        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
        self.end_headers()
        self.wfile.write(body)


def build_test_extension(directory: Path) -> None:
    for name in ('manifest.json', 'background.js', 'popup.html', 'popup.css',
                 'popup.js', 'icons', 'src'):
        source = ROOT / name
        target = directory / name
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)

    manifest_path = directory / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    manifest['name'] = 'TVU Firefox smoke test'
    manifest['host_permissions'].append('http://127.0.0.1/*')
    manifest['content_scripts'] = [{
        'matches': ['http://127.0.0.1/*'],
        'js': ['smoke-content.js'],
        'run_at': 'document_idle',
    }]
    manifest_path.write_text(json.dumps(manifest, indent=2))

    (directory / 'smoke-content.js').write_text(
        "document.documentElement.setAttribute('data-tvu-smoke-loaded', '1');\n")

    background_path = directory / 'background.js'
    background = background_path.read_text()
    old = "      'https://*.twitch.tv/*'\n"
    new = "      'https://*.twitch.tv/*',\n      'http://127.0.0.1/*'\n"
    if background.count(old) != 2:
        raise RuntimeError('unexpected webRequest filter layout in background.js')
    background = background.replace(old, new)
    background_path.write_text(background)


def main() -> int:
    node_bin = Path('/tmp/opencode/tools/node-v22.14.0-linux-x64/bin')
    web_ext = shutil.which('web-ext')
    if not web_ext and (Path('/tmp/opencode/tools/node_modules/.bin/web-ext')).exists():
        web_ext = str(Path('/tmp/opencode/tools/node_modules/.bin/web-ext'))
    if not web_ext:
        print('web-ext not found; set up portable Node/web-ext first', file=sys.stderr)
        return 2

    env = os.environ.copy()
    env['PATH'] = str(node_bin) + os.pathsep + env.get('PATH', '')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    with tempfile.TemporaryDirectory(prefix='tvu-smoke-') as temp:
        extension_dir = Path(temp) / 'extension'
        extension_dir.mkdir()
        build_test_extension(extension_dir)
        command = [
            web_ext, 'run',
            '--source-dir', str(extension_dir),
            '--no-input',
            '--no-reload',
            '--firefox', shutil.which('firefox') or 'firefox',
            '--args=-headless',
            '--args=--window-size=1280,720',
            '--url', f'http://127.0.0.1:{port}/',
        ]

        process = subprocess.Popen(
            command, env=env, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, start_new_session=True)

        playlist_path = '/vod/12345/720p60/index-muted-ABC.m3u8'
        # Probes carry Range: bytes=0-1. Player requests do not. The two
        # available segments must be redirected before the player's request
        # reaches the server; the purged one stays muted.
        expected = [
            (playlist_path, None),
            ('/vod/12345/720p60/0.ts', 'bytes=0-1'),
            ('/vod/12345/720p60/1.ts', 'bytes=0-1'),
            ('/vod/12345/720p60/2.ts', 'bytes=0-1'),
            ('/vod/12345/720p60/0.ts', None),
            ('/vod/12345/720p60/1-muted.ts', None),
            ('/vod/12345/720p60/2.ts', None),
        ]
        deadline = time.time() + 45
        seen = []
        while time.time() < deadline and process.poll() is None:
            with Handler.lock:
                seen = list(Handler.request_log)
            if all(item in seen for item in expected):
                break
            time.sleep(0.25)

        try:
            os.killpg(os.getpgid(process.pid), 15)
        except ProcessLookupError:
            pass
        try:
            output, _ = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(process.pid), 9)
            output, _ = process.communicate()

    server.shutdown()
    server.server_close()

    print('requests observed:')
    for path, range_header in seen:
        print(' ', path, 'Range=' + str(range_header))

    missing = [item for item in expected if item not in seen]
    if ('/vod/12345/720p60/1.ts', None) in seen:
        missing.append('ERROR: purged segment 1 was incorrectly redirected')
    for name in ('0-muted.ts', '2-muted.ts'):
        if ('/vod/12345/720p60/' + name, None) in seen:
            missing.append('ERROR: ' + name + ' was not redirected in time')
    if missing:
        print('SMOKE TEST FAILED. Missing:', missing, file=sys.stderr)
        print(output[-4000:], file=sys.stderr)
        return 1

    print('SMOKE TEST PASSED: Firefox restored the available segments.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
