#!/bin/bash
# Build the Agon wasm emulator.
#
# Two emscripten modules are produced:
#   vdp.js/vdp.wasm  C++ FabGL VDP firmware (pthreads; page must be served
#                    with COOP/COEP headers, see serve.py)
#   cpu.js/cpu.wasm  Rust eZ80 core + MOS (single threaded, stepped from
#                    requestAnimationFrame)
# The UART between them is bridged in JS (uart_lib.js + index.html).
#
# Prereqs:
#   - emsdk activated in this shell (source ~/emsdk/emsdk_env.sh)
#   - rustup target add wasm32-unknown-emscripten
#   - git submodule update --init --recursive
set -e
cd "$(dirname "$0")"
FAB=fab-agon-emulator
VDP=$FAB/src/vdp

# upstream needs a small patch (cooperative stepping API on AgonMachine);
# apply once, skip when already applied
if ! grep -q "pub fn run_cycles" $FAB/agon-ez80-emulator/src/agon_machine.rs; then
  echo "=== applying patch to $FAB ==="
  git -C $FAB apply ../patches/agon-ez80-emulator-wasm.patch
fi

INCLUDES="-I$FAB/src -I$VDP -I$VDP/userspace-vdp-gl/src \
  -I$VDP/userspace-vdp-gl/src/userspace-platform \
  -I$VDP/userspace-vdp-gl/src/dispdrivers \
  -I$VDP/userspace-vdp-gl/src/userspace-platform/matrix \
  -I$VDP/vdp-console8/video"

echo "=== 1/4 vdp-gl static lib ==="
emmake make -C $VDP/userspace-vdp-gl/src CXX=em++ AR=emar SUFFIX=.mt EXTRA_FLAGS="-pthread"

echo "=== 2/4 VDP glue + firmware ==="
em++ -pthread -O2 -std=c++17 -DUSERSPACE $INCLUDES -c $VDP/rust_glue.cpp    -o rust_glue.o
em++ -pthread -O2 -std=c++17 -DUSERSPACE $INCLUDES -c $VDP/vdp-console8.cpp -o vdp-console8.o
em++ -pthread -O2 -std=c++17 -DUSERSPACE $INCLUDES -c web_glue.cpp          -o web_glue.o

echo "=== 3/4 link VDP module ==="
em++ -O2 -pthread -sPTHREAD_POOL_SIZE=8 -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB \
  -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 -sENVIRONMENT=web,worker \
  -sMODULARIZE -sEXPORT_NAME=createVDP \
  -sEXPORTED_FUNCTIONS='_web_boot,_web_frame,_web_vblank,_web_fb,_web_w,_web_h,_web_hz,_web_send,_web_recv,_web_cts,_web_key,_web_audio' \
  -sEXPORTED_RUNTIME_METHODS='HEAPU8' \
  web_glue.o rust_glue.o vdp-console8.o $VDP/userspace-vdp-gl/src/vdp-gl.mt.a \
  -o vdp.js

echo "=== 4/4 CPU module (Rust eZ80 + MOS) ==="
(cd agon-cpu-wasm && cargo build --release --target wasm32-unknown-emscripten)
em++ -O2 -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB -sSTACK_SIZE=4MB \
  -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 -sENVIRONMENT=web \
  -sMODULARIZE -sEXPORT_NAME=createCPU -sFORCE_FILESYSTEM \
  -sEXPORTED_FUNCTIONS='_agon_cpu_init,_agon_cpu_run_ms' \
  -sEXPORTED_RUNTIME_METHODS='FS,HEAPU8' \
  --js-library uart_lib.js \
  agon-cpu-wasm/target/wasm32-unknown-emscripten/release/libagon_cpu_wasm.a \
  -o cpu.js

rm -f web_glue.o rust_glue.o vdp-console8.o
echo "done: vdp.js vdp.wasm cpu.js cpu.wasm"
echo "run:  python3 serve.py   then open http://127.0.0.1:8842/"
