#!/usr/bin/env python3
# Minimal static server that sets the COOP/COEP headers wasm pthreads need
# (SharedArrayBuffer is gated behind cross-origin isolation).
import http.server, os, socketserver

# serve the repo root: the page is at /, firmware and sdcard files are
# fetched from the fab-agon-emulator submodule
os.chdir(os.path.dirname(os.path.abspath(__file__)))

PORT = 8842

# the wasm modules are build artifacts, not checked in: catch the missing-build
# case here instead of letting the page die with 404s and "createVDP is not defined"
MISSING = [f for f in ('vdp.js', 'vdp.wasm', 'cpu.js', 'cpu.wasm') if not os.path.exists(f)]
if MISSING:
    raise SystemExit(
        f"missing build artifacts: {', '.join(MISSING)}\n"
        "Run ./build.sh first (needs Emscripten + Rust, see README), or download\n"
        "prebuilt files from the GitHub releases page and drop them in this directory."
    )

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

if __name__ == '__main__':
    # without this, restarting right after Ctrl-C fails with
    # "Address already in use" while the old socket sits in TIME_WAIT
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', PORT), H) as httpd:
        print(f'serving on http://127.0.0.1:{PORT}')
        httpd.serve_forever()
