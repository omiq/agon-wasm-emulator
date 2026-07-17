// Emscripten JS library: UART0 bridge for the CPU module.
// The page assigns globalThis.__agon_uart = {send, recv, cts} once the VDP
// module is up; before that, bytes are dropped and recv returns -1.
mergeInto(LibraryManager.library, {
  host_uart0_send: function (b) {
    if (globalThis.__agon_uart) globalThis.__agon_uart.send(b);
  },
  host_uart0_recv: function () {
    return globalThis.__agon_uart ? globalThis.__agon_uart.recv() : -1;
  },
  host_uart0_cts: function () {
    return globalThis.__agon_uart ? globalThis.__agon_uart.cts() : 0;
  },
});
