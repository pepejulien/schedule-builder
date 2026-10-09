#!/usr/bin/env python3
"""Serve public/ on http://localhost:8765 with the mock JAJB bundle injected,
so the Firebase-only screens (the Live board) can be tried on this PC.
Fixtures are at /__fixtures/. TEST ONLY.

    python tests/live_mock/serve.py

Speed checks: ?lat=300 adds Firestore-like latency (jajb-mock.js); make_seed.py
writes the test week and /__mock/perf-harness.js times the board on it.
"""
import http.server
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, '..', '..', 'public')
FIX = os.path.join(HERE, '..', 'fixtures')
# the Driver Board's last local build, served as the fake Driver Dashboard data
BOARD = r'C:\Claude Code\JAJB-Driver-Board\data\driver_standing.json'
PORT = int(os.environ.get('PORT', '8777'))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=PUBLIC, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path in ('/', '/index.html'):
            html = open(os.path.join(PUBLIC, 'index.html'), encoding='utf-8').read()
            html = html.replace('</title>', '</title>\n  <script src="/__mock/jajb-mock.js"></script>', 1)
            return self._send(html.encode('utf-8'), 'text/html; charset=utf-8')
        if path in ('/__mock/jajb-mock.js', '/__mock/perf-harness.js'):
            return self._send(open(os.path.join(HERE, os.path.basename(path)), 'rb').read(), 'text/javascript')
        if path == '/__board.json' and os.path.isfile(BOARD):
            return self._send(open(BOARD, 'rb').read(), 'application/json')
        if path.startswith('/__fixtures/'):
            f = os.path.join(FIX, os.path.basename(path))
            if os.path.isfile(f):
                return self._send(open(f, 'rb').read(), 'application/octet-stream')
        return super().do_GET()


if __name__ == '__main__':
    print(f'http://localhost:{PORT}/')
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
