// Agon emulator core: boots the VDP + CPU wasm modules, blits to a canvas,
// wires the UART bridge and keyboard, and exposes a small API for hosts
// (the standalone page and the iframe embed both use this).
//
// startAgon({canvas, baseUrl, jsBase, sdFiles, onLog, onReady}) -> Promise<api>
//   canvas   : the <canvas> to render into (also receives keyboard focus)
//   baseUrl  : prefix for firmware/sdcard fetches (default: 'fab-agon-emulator')
//   jsBase   : prefix for the vdp.js script fetch (default: '', i.e. alongside
//              the page) — must match the <script src> that loaded vdp.js
//   assetVer : cache-buster appended as ?v=<assetVer> to every asset fetch
//              (wasm, worker script, firmware) — without it, CDNs and the
//              browser HTTP cache happily serve a stale module set after a
//              redeploy (optional)
//   sdFiles  : [{path, url}] fetched onto the sdcard at boot (optional)
//   onLog    : function(msg) for status lines (optional)
//   onReady  : called once MOS is booting and input can be queued (optional)
//   onUartTx : function(byte) for every CPU->VDP byte (optional; prompt detection)
// api:
//   writeFile(path, bytes)     : put a Uint8Array onto the emulated sdcard
//   typeText(text)             : queue text to be typed (use \r for Enter)
//   runProgram(files, commands): write files + an autoexec.txt of MOS CLI
//                                lines, then cold-boot — MOS executes the
//                                script itself at startup. Deterministic:
//                                no synthetic keyboard input, no waiting
//                                for a prompt.
//   coldBoot()                 : re-init the CPU/MOS (VDP keeps running;
//                                the rebooting MOS re-handshakes it)
//   vdp, cpu                   : the raw emscripten module handles

// KeyboardEvent.code -> PS/2 scancode set 2 make code (0xE0xx = extended)
const PS2_CODES = {
  KeyA:0x1C, KeyB:0x32, KeyC:0x21, KeyD:0x23, KeyE:0x24, KeyF:0x2B, KeyG:0x34,
  KeyH:0x33, KeyI:0x43, KeyJ:0x3B, KeyK:0x42, KeyL:0x4B, KeyM:0x3A, KeyN:0x31,
  KeyO:0x44, KeyP:0x4D, KeyQ:0x15, KeyR:0x2D, KeyS:0x1B, KeyT:0x2C, KeyU:0x3C,
  KeyV:0x2A, KeyW:0x1D, KeyX:0x22, KeyY:0x35, KeyZ:0x1A,
  Digit1:0x16, Digit2:0x1E, Digit3:0x26, Digit4:0x25, Digit5:0x2E,
  Digit6:0x36, Digit7:0x3D, Digit8:0x3E, Digit9:0x46, Digit0:0x45,
  Enter:0x5A, Space:0x29, Backspace:0x66, Tab:0x0D, Escape:0x76,
  Minus:0x4E, Equal:0x55, BracketLeft:0x54, BracketRight:0x5B,
  Backslash:0x5D, Semicolon:0x4C, Quote:0x52, Backquote:0x0E,
  Comma:0x41, Period:0x49, Slash:0x4A, CapsLock:0x58,
  ShiftLeft:0x12, ShiftRight:0x59, ControlLeft:0x14, AltLeft:0x11,
  F1:0x05, F2:0x06, F3:0x04, F4:0x0C, F5:0x03, F6:0x0B, F7:0x83, F8:0x0A,
  F9:0x01, F10:0x09, F11:0x78, F12:0x07,
  ControlRight:0xE014, AltRight:0xE011, Insert:0xE070, Delete:0xE071,
  Home:0xE06C, End:0xE069, PageUp:0xE07D, PageDown:0xE07A,
  ArrowLeft:0xE06B, ArrowRight:0xE074, ArrowUp:0xE075, ArrowDown:0xE072,
};

// character -> [ps2 make code, needsShift] for typeText (US layout, as the VDP defaults)
const CHAR_PS2 = (() => {
  const m = {};
  for (const [code, ps2] of Object.entries(PS2_CODES)) {
    if (code.startsWith('Key')) {
      m[code.slice(3).toLowerCase()] = [ps2, false];
      m[code.slice(3)] = [ps2, true];
    }
    if (code.startsWith('Digit')) m[code.slice(5)] = [ps2, false];
  }
  Object.assign(m, {
    ' ': [0x29, false], '\r': [0x5A, false], '\n': [0x5A, false],
    '-': [0x4E, false], '_': [0x4E, true], '=': [0x55, false], '+': [0x55, true],
    '[': [0x54, false], '{': [0x54, true], ']': [0x5B, false], '}': [0x5B, true],
    '\\': [0x5D, false], '|': [0x5D, true], ';': [0x4C, false], ':': [0x4C, true],
    "'": [0x52, false], '"': [0x52, true], '`': [0x0E, false], '~': [0x0E, true],
    ',': [0x41, false], '<': [0x41, true], '.': [0x49, false], '>': [0x49, true],
    '/': [0x4A, false], '?': [0x4A, true],
    '!': [0x16, true], '@': [0x1E, true], '#': [0x26, true], '$': [0x25, true],
    '%': [0x2E, true], '^': [0x36, true], '&': [0x3D, true], '*': [0x3E, true],
    '(': [0x46, true], ')': [0x45, true],
  });
  return m;
})();

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch failed: ' + url);
  return new Uint8Array(await r.arrayBuffer());
}

async function startAgon(opts) {
  const canvas = opts.canvas;
  const base = opts.baseUrl !== undefined ? opts.baseUrl : 'fab-agon-emulator';
  const jsBase = opts.jsBase !== undefined ? opts.jsBase : '';
  const ver = opts.assetVer ? '?v=' + opts.assetVer : '';
  const log = opts.onLog || (() => {});
  const ctx = canvas.getContext('2d');
  let img = null, imgW = 0, imgH = 0;

  log('loading VDP module...');
  // The VDP is a pthreads build: it spawns dedicated workers from its own
  // script URL. Under COEP: require-corp (which SharedArrayBuffer forces on
  // the page) a worker SCRIPT response must itself carry COEP headers, and
  // static file servers usually don't send them -> "worker sent an error!".
  // A blob: URL inherits the creating document's policy, so feeding the
  // script to emscripten as a Blob makes worker spawning independent of
  // server header config. Falls back to the default spawn if the fetch fails.
  // locateFile routes the emscripten-side wasm fetches through the same
  // versioned URLs, so a redeploy can never pair a fresh .js with a stale
  // CDN-cached .wasm
  const vdpArg = { locateFile: f => jsBase + f + ver };
  try {
    const r = await fetch(jsBase + 'vdp.js' + ver);
    if (r.ok) vdpArg.mainScriptUrlOrBlob = new Blob([await r.text()], { type: 'text/javascript' });
  } catch (e) { /* same-origin fetch failed; let emscripten try its default */ }
  const vdp = await createVDP(vdpArg);
  vdp._web_boot();

  // onUartTx (optional) sees every byte the CPU sends to the VDP — hosts use
  // it to detect real boot progress (e.g. the first '*' of the MOS prompt)
  // instead of guessing with wall-clock delays, which break badly when the
  // page is occluded and timers throttle to ~1Hz (MOS runs at ~3% speed).
  globalThis.__agon_uart = {
    send: b => { if (opts.onUartTx) opts.onUartTx(b); vdp._web_send(b); },
    recv: () => vdp._web_recv(),
    cts:  () => vdp._web_cts(),
  };

  log('loading CPU module...');
  const cpu = await createCPU({ locateFile: f => jsBase + f + ver });

  log('fetching MOS firmware...');
  cpu.FS.writeFile('/mos.bin', await fetchBytes(base + '/firmware/mos_platform.bin' + ver));
  cpu.FS.writeFile('/mos.map', await fetchBytes(base + '/firmware/mos_platform.map' + ver));

  const mkdirs = path => {
    const parts = path.split('/').filter(Boolean).slice(0, -1);
    let dir = '';
    for (const p of parts) {
      dir += '/' + p;
      try { cpu.FS.mkdir('/sdcard' + dir); } catch (e) { /* exists */ }
    }
  };
  try { cpu.FS.mkdir('/sdcard'); } catch (e) { /* exists */ }

  const writeFile = (path, bytes) => {
    mkdirs('/' + path);
    cpu.FS.writeFile('/sdcard/' + path, bytes);
  };

  for (const f of (opts.sdFiles || [])) {
    writeFile(f.path, await fetchBytes(f.url));
    log('sdcard: ' + f.path);
  }

  cpu._agon_cpu_init(512);
  log('eZ80 up (18.432MHz, 512KiB RAM). MOS booting...');

  // live keyboard
  canvas.addEventListener('keydown', e => {
    const c = PS2_CODES[e.code]; if (c === undefined) return;
    e.preventDefault(); vdp._web_key(c, 1);
  });
  canvas.addEventListener('keyup', e => {
    const c = PS2_CODES[e.code]; if (c === undefined) return;
    e.preventDefault(); vdp._web_key(c, 0);
  });

  // auto-typing queue: one key event per frame-ish keeps MOS happy
  const typeQueue = [];
  const typeText = text => {
    for (const ch of text) {
      const entry = CHAR_PS2[ch];
      if (!entry) continue;
      const [code, shift] = entry;
      if (shift) typeQueue.push([0x12, 1]);
      typeQueue.push([code, 1], [code, 0]);
      if (shift) typeQueue.push([0x12, 0]);
    }
  };

  // Emulation is driven by setInterval, NOT requestAnimationFrame: Chrome
  // stops rAF completely for hidden/occluded pages (including iframes
  // scrolled offscreen in an IDE), which would freeze the machine. Timers
  // keep firing (throttled to ~1Hz when hidden), so the emulator survives.
  let last = performance.now();
  let keyAccum = 0;
  let vsyncAccum = 0;
  setInterval(() => {
    const now = performance.now();
    const rawMs = now - last;
    const ms = Math.min(Math.round(rawMs), 30);
    last = now;

    // ~60Hz vsync heartbeat, independent of tick rate
    vsyncAccum += ms;
    while (vsyncAccum >= 16) { cpu._agon_cpu_vsync(); vsyncAccum -= 16; }

    if (ms > 0) cpu._agon_cpu_run_ms(ms);

    // auto-typing: pace by WALL CLOCK (one key event per ~32ms), not by tick
    // count — when the page is occluded, ticks throttle to ~1Hz and a
    // tick-counted cooldown stretches to seconds per key. Budgeting on rawMs
    // lets throttled ticks send a small burst (capped; the VDP keyboard
    // queue and MOS line buffer absorb it) so typing finishes regardless.
    if (typeQueue.length) {
      keyAccum = Math.min(keyAccum + rawMs, 8 * 32);
      while (typeQueue.length && keyAccum >= 32) {
        keyAccum -= 32;
        const [code, down] = typeQueue.shift();
        vdp._web_key(code, down);
      }
    } else {
      keyAccum = 0;
    }
    vdp._web_vblank();
  }, 8);

  // rendering can happily pause when not visible
  function blit() {
    vdp._web_frame();
    const w = vdp._web_w(), h = vdp._web_h();
    if (w > 0 && h > 0) {
      if (w !== imgW || h !== imgH) {
        imgW = w; imgH = h;
        canvas.width = w; canvas.height = h;
        img = ctx.createImageData(w, h);
        log('video mode: ' + w + 'x' + h + ' @ ' + vdp._web_hz().toFixed(1) + 'Hz');
      }
      const ptr = vdp._web_fb();
      const rgb = vdp.HEAPU8.subarray(ptr, ptr + w * h * 3);
      const d = img.data;
      let s = 0, o = 0;
      for (let i = 0; i < w * h; i++) {
        d[o++] = rgb[s++]; d[o++] = rgb[s++]; d[o++] = rgb[s++]; d[o++] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }
    requestAnimationFrame(blit);
  }
  requestAnimationFrame(blit);

  const coldBoot = () => {
    // drain stale VDP->CPU bytes so the fresh MOS doesn't read leftovers
    // from the previous session's uart stream
    while (vdp._web_recv() >= 0) { /* drain */ }
    cpu._agon_cpu_init(512);
    log('cold boot');
  };

  // The native program-launch path: MOS runs /autoexec.txt at boot, one CLI
  // command per line. Writing the program + script and rebooting makes MOS
  // do the launch itself — immune to keyboard timing and tab throttling.
  const runProgram = (files, commands) => {
    for (const f of (files || [])) writeFile(f.path, f.bytes);
    const script = commands.join('\r\n') + '\r\n';
    writeFile('autoexec.txt', new TextEncoder().encode(script));
    coldBoot();
  };

  if (opts.onReady) opts.onReady();
  return { writeFile, typeText, runProgram, coldBoot, vdp, cpu };
}
