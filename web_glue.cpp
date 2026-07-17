// Prototype web glue: drive the VDP wasm module from JS and expose a
// framebuffer for canvas blitting. No ez80, no serial protocol — just boot
// the VDP firmware and read whatever it draws (the Agon boot screen).
#include <cstdint>
#include <cstring>
#include <mutex>
#include <thread>
#include <atomic>

extern "C" void vdp_setup();
extern "C" void signal_vblank();
extern "C" void copyVgaFramebuffer(int *outW, int *outH, void *buf, float *hz);
extern "C" void z80_send_to_vdp(uint8_t b);
extern "C" bool z80_recv_from_vdp(uint8_t *out);
extern "C" bool z80_uart0_is_cts();
extern "C" void sendPS2KbEventToFabgl(uint16_t ps2scancode, uint8_t isDown);
extern "C" void getAudioSamples(uint8_t *buffer, uint32_t length);

// Big enough for any Agon mode (max 1024x768x3).
static uint8_t g_fb[1024 * 768 * 3];
static int g_w = 0, g_h = 0;
static float g_hz = 0.0f;

extern "C" void web_boot()            { vdp_setup(); }
extern "C" void web_vblank()          { signal_vblank(); }
extern "C" void web_frame()           { copyVgaFramebuffer(&g_w, &g_h, g_fb, &g_hz); }
extern "C" uint8_t *web_fb()          { return g_fb; }
extern "C" int   web_w()              { return g_w; }
extern "C" int   web_h()              { return g_h; }
extern "C" float web_hz()             { return g_hz; }
extern "C" void  web_send(uint8_t b)  { z80_send_to_vdp(b); }
extern "C" int   web_recv()           { uint8_t b; return z80_recv_from_vdp(&b) ? b : -1; }
extern "C" int   web_cts()            { return z80_uart0_is_cts() ? 1 : 0; }
extern "C" void  web_key(uint16_t ps2, uint8_t down) { sendPS2KbEventToFabgl(ps2, down); }

static uint8_t g_audio[2048];
extern "C" uint8_t *web_audio(uint32_t n) { getAudioSamples(g_audio, n > 2048 ? 2048 : n); return g_audio; }

