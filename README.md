# Agon WASM Emulator

An Agon Light / Agon Console8 emulator that runs entirely in the browser. This is a WebAssembly port of Tom Morton's excellent [fab-agon-emulator](https://github.com/tomm/fab-agon-emulator), which does the heavy lifting here: its Rust eZ80 core and its C++ VDP firmware both compile to wasm with only small changes.

MOS boots to the prompt, the keyboard works, and BBC BASIC loads and runs programs from an emulated SD card, in a browser with no setup/install.

Built so the [Online Retro IDE](https://ide.retrogamecoders.com) can target the Agon, but it stands alone as a plain web site.

## How it works

Two WebAssembly modules run on the page, mirroring the chips in the real machine:

* `vdp.wasm` is the C++ VDP firmware (agon-vdp running on vdp-gl, the userspace FabGL fork). It spawns real threads, so it is compiled with Emscripten pthreads and the page must be served with cross-origin isolation headers (see below).
* `cpu.wasm` is the Rust eZ80 CPU and machine emulation from fab-agon-emulator, compiled single threaded with the Rust toolchain and stepped from `requestAnimationFrame`.

On real hardware the two processors talk over a serial UART. Here that link is a few lines of JavaScript passing bytes between the two modules (`uart_lib.js` plus the glue in `index.html`). The MOS firmware and the SD card contents live in Emscripten's in-memory filesystem, so the host page can drop files onto the card with a single `FS.writeFile` call. That is how the IDE uses to execute cimpiled programs.

## Quick start (prebuilt, no toolchains)

The wasm modules are build artifacts and are not checked into the repo, so a plain clone will not run (the page dies with 404s on `vdp.js` and `cpu.js`, and `FATAL: createVDP is not defined` in the console). If you don't want to install Emscripten and Rust, grab the prebuilt files instead:

```
git clone --recursive https://github.com/omiq/agon-wasm-emulator
cd agon-wasm-emulator
```

Then download `vdp.js`, `vdp.wasm`, `cpu.js` and `cpu.wasm` from the [latest release](https://github.com/omiq/agon-wasm-emulator/releases/latest) into the repo root, and:

```
python3 serve.py
```

The `--recursive` matters either way: the MOS firmware and the emulated SD card contents are fetched from the `fab-agon-emulator` submodule at runtime.

## Building

Prerequisites:

* [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) (tested with emcc 5.0.4)
* Stable Rust with the Emscripten target: `rustup target add wasm32-unknown-emscripten`
* Python 3 for the dev server

```
git clone --recursive https://github.com/omiq/agon-wasm-emulator
cd agon-wasm-emulator
source ~/emsdk/emsdk_env.sh
./build.sh
python3 serve.py
```

Open http://127.0.0.1:8842/ , click the screen, and enter:

```
dir
bin/bbcbasic demos/fireworks.bas
```

`build.sh` applies a patch (in `patches/`) to the fab-agon-emulator submodule. It adds a cooperative stepping API to the AgonMachine struct so the CPU can be driven from the browser's frame loop instead of a blocking thread. Nothing else in upstream is modified.

A note on hosting: the VDP module uses pthreads, which need `SharedArrayBuffer`, which browsers only allow on cross-origin isolated pages. `serve.py` sends the required `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers for local use. If you host this anywhere else, your server must send the same two headers.

## Embedding in another page (IDE use)

`embed.html` is a minimal build of the emulator with a postMessage API, made for iframes. `ide-demo.html` is a working example of the flow. edit a BBC BASIC program in a textarea, click run, and it executes in the emulator next to it.

```
<iframe id="emu" src="embed.html"></iframe>
<script>
  document.getElementById('emu').contentWindow.postMessage({
    type: 'agon-run',
    files: [{ path: 'demos/prog.bas', data: sourceText }],
    command: 'bin/bbcbasic demos/prog.bas',
  }, '*');
</script>
```

Messages accepted: `agon-files` (write files to the sdcard), `agon-type` (type text at the prompt, `\r` for Enter), and `agon-run` (both at once). The embed replies with `agon-ready` when MOS is up and `agon-log` status lines. String file data is normalised to CRLF line endings, which BBC BASIC's text loader requires. Messages sent before boot completes are queued and replayed.

Two things the host page must get right:

* The top-level document (not just the iframe) must be served with the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers, because `SharedArrayBuffer` only exists on cross-origin isolated pages and isolation is decided at the top level.
* The emulator boots with the Agon Platform firmware (MOS 3.0.2 at the time of writing), the current mainline. The other firmware variants in the fab-agon-emulator submodule (console8, quark, electron) can be swapped in by changing the two fetches in `agon-emulator.js`.

Emulation is driven by a timer rather than `requestAnimationFrame`, so the machine keeps running when the page or iframe is scrolled offscreen or occluded (Chrome stops rAF entirely for hidden content; timers it merely throttles).

## Status

Working prototype, warts and all. What works: Agon Platform MOS 3.0.2 boot, keyboard input, the SD card as a fetched-into-memory directory, BBC BASIC and the graphics demos from the standard card. Not wired up yet: audio (the export exists on the VDP module, it needs a WebAudio worklet), mouse, joysticks, and most of the desktop emulator's command line options.

## License and credits

GPL-3.0, the same as fab-agon-emulator. See [LICENSE](LICENSE).

This project is a thin layer over other people's work:

* [fab-agon-emulator](https://github.com/tomm/fab-agon-emulator) by Tom Morton, including the [userspace vdp-gl fork](https://github.com/tomm/userspace-vdp-gl) that replaces the ESP32 hardware layer so an emulator can drive it
* [vdp-gl](https://github.com/AgonPlatform/vdp-gl), the Agon Platform fork of FabGL: the work on top of FabGL is mostly by Steve Sims and the Agon Platform contributors
* [agon-vdp](https://github.com/AgonPlatform/agon-vdp) and [MOS](https://github.com/AgonPlatform/agon-mos) by Dean Belfield, Steve Sims and the Agon Platform contributors
* [FabGL](https://github.com/fdivitto/FabGL), which vdp-gl descends from, by Fabrizio Di Vittorio
