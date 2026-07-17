#!/usr/bin/env python3
# Minimal static server that sets the COOP/COEP headers wasm pthreads need
# (SharedArrayBuffer is gated behind cross-origin isolation).
import http.server, os, socketserver

# serve the repo root: the page is at /, firmware and sdcard files are
# fetched from the fab-agon-emulator submodule
os.chdir(os.path.dirname(os.path.abspath(__file__)))

PORT = 8842

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

if __name__ == '__main__':
    with socketserver.TCPServer(('127.0.0.1', PORT), H) as httpd:
        print(f'serving on http://127.0.0.1:{PORT}')
        httpd.serve_forever()
