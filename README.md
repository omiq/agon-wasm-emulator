# Agon WASM Emulator

An Agon Light / Agon Console8 emulator that runs entirely in the browser. This is a WebAssembly port of Tom Morton's excellent [fab-agon-emulator](https://github.com/tomm/fab-agon-emulator), which does all the heavy lifting here: its Rust eZ80 core and its C++ VDP firmware both compile to wasm with only small changes.

MOS boots to the familiar prompt, the keyboard works, and BBC BASIC loads and runs programs from an emulated SD card, all in a browser tab with no install.

Built so the [Online Retro IDE](https://ide.retrogamecoders.com) can target the Agon, but it stands alone as a plain web page too.

## How it works

Two WebAssembly modules run side by side on the page, mirroring the two chips in the real machine:

* `vdp.wasm` is the C++ VDP firmware (agon-vdp running on vdp-gl, the userspace FabGL fork). It spawns real threads, so it is compiled with Emscripten pthreads and the page must be served with cross-origin isolation headers (see below).
* `cpu.wasm` is the Rust eZ80 CPU and machine emulation from fab-agon-emulator, compiled single threaded with the stable Rust toolchain and stepped from `requestAnimationFrame`.

On real hardware the two processors talk over a serial UART. Here that link is a few lines of JavaScript passing bytes between the two modules (`uart_lib.js` plus the glue in `index.html`). The MOS firmware and the SD card contents live in Emscripten's in-memory filesystem, so the host page can drop files onto the card with a single `FS.writeFile` call. That is the hook the IDE uses to inject programs.

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

Open http://127.0.0.1:8842/ , click the screen, and type:

```
dir
bin/bbcbasic demos/fireworks.bas
```

`build.sh` applies a small patch (in `patches/`) to the fab-agon-emulator submodule. It adds a cooperative stepping API to the AgonMachine struct so the CPU can be driven from the browser's frame loop instead of a blocking thread. Nothing else in upstream is modified.

A note on hosting: the VDP module uses pthreads, which need `SharedArrayBuffer`, which browsers only allow on cross-origin isolated pages. `serve.py` sends the required `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers for local use. If you host this anywhere else, your server must send the same two headers.

## Status

Working prototype, warts and all. What works: MOS 2.3.3 boot, keyboard input, the SD card as a fetched-into-memory directory, BBC BASIC and the graphics demos from the standard card. Not wired up yet: audio (the export exists on the VDP module, it needs a WebAudio worklet), mouse, joysticks, and most of the desktop emulator's command line options.

## License and credits

GPL-3.0, the same as fab-agon-emulator. See [LICENSE](LICENSE).

This project is a thin layer over other people's work:

* [fab-agon-emulator](https://github.com/tomm/fab-agon-emulator) and [vdp-gl](https://github.com/tomm/userspace-vdp-gl) by Tom Morton
* [agon-vdp](https://github.com/AgonPlatform/agon-vdp) and [MOS](https://github.com/AgonPlatform/agon-mos) by Dean Belfield, Steve Sims and the Agon Platform contributors
* [FabGL](https://github.com/fdivitto/FabGL), which vdp-gl descends from, by Fabrizio Di Vittorio
