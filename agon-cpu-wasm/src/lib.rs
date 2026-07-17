// C-ABI wrapper around AgonMachine for the browser prototype.
// UART0 (the VDP link) is bridged out to JS, which forwards the bytes to the
// separately-loaded VDP wasm module.
use agon_ez80_emulator::ez80::Cpu;
use agon_ez80_emulator::{gpio, AgonMachine, AgonMachineConfig, RamInit, SerialLink};
use std::sync::atomic::{AtomicBool, AtomicI32};
use std::sync::Arc;

// Implemented in JS (--js-library uart_lib.js)
extern "C" {
    fn host_uart0_send(b: u8);
    fn host_uart0_recv() -> i32; // -1 = no byte available
    fn host_uart0_cts() -> i32;
}

struct JsVdpLink;
impl SerialLink for JsVdpLink {
    fn send(&mut self, byte: u8) {
        unsafe { host_uart0_send(byte) }
    }
    fn recv(&mut self) -> Option<u8> {
        let v = unsafe { host_uart0_recv() };
        if v < 0 {
            None
        } else {
            Some(v as u8)
        }
    }
    fn read_clear_to_send(&mut self) -> bool {
        unsafe { host_uart0_cts() != 0 }
    }
}

struct DummyLink;
impl SerialLink for DummyLink {
    fn send(&mut self, _byte: u8) {}
    fn recv(&mut self) -> Option<u8> {
        None
    }
    fn read_clear_to_send(&mut self) -> bool {
        false
    }
}

struct EmuState {
    machine: AgonMachine,
    cpu: Cpu,
    gpios: Arc<gpio::GpioSet>,
    _rx_frame: std::sync::mpsc::Receiver<agon_ez80_emulator::GpioVgaFrame>,
}

static mut STATE: Option<EmuState> = None;

/// ram_size_kib: external RAM size (normally 512)
#[no_mangle]
pub extern "C" fn agon_cpu_init(ram_size_kib: u32) {
    let (tx_frame, rx_frame) = std::sync::mpsc::channel();
    let gpios = Arc::new(gpio::GpioSet::new());
    let mut machine = AgonMachine::new(AgonMachineConfig {
        ram_init: RamInit::Zero,
        uart0_link: Box::new(JsVdpLink),
        uart1_link: Box::new(DummyLink),
        gpios: gpios.clone(),
        soft_reset: Arc::new(AtomicBool::new(false)),
        emulator_shutdown: Arc::new(AtomicBool::new(false)),
        exit_status: Arc::new(AtomicI32::new(0)),
        paused: Arc::new(AtomicBool::new(false)),
        tx_gpio_vga_frame: tx_frame,
        clockspeed_hz: 18_432_000,
        mos_bin: std::path::PathBuf::from("/mos.bin"),
        interrupt_precision: 16,
        external_ram_size: ram_size_kib * 1024,
    });
    machine.set_sdcard_directory(std::path::PathBuf::from("/sdcard"));
    machine.set_sdcard_image(None);
    let mut cpu = Cpu::new_ez80();
    machine.prepare(&mut cpu);
    unsafe {
        STATE = Some(EmuState {
            machine,
            cpu,
            gpios,
            _rx_frame: rx_frame,
        });
    }
}

/// Run approximately `ms` milliseconds of emulated cpu time.
#[no_mangle]
pub extern "C" fn agon_cpu_run_ms(ms: u32) {
    let st = unsafe {
        match &mut *std::ptr::addr_of_mut!(STATE) {
            Some(st) => st,
            None => return,
        }
    };
    let cycles = 18_432_000u64 / 1000 * ms as u64;
    st.machine.run_cycles(&mut st.cpu, cycles);
}

#[no_mangle]
pub extern "C" fn agon_cpu_pc() -> u32 {
    unsafe {
        match &*std::ptr::addr_of!(STATE) {
            Some(st) => st.cpu.state.pc(),
            None => 0,
        }
    }
}

/// Pulse the vsync GPIO (port B pin 1), as the desktop render loop does each
/// frame. MOS and BBC BASIC block in HALT waiting for this interrupt.
#[no_mangle]
pub extern "C" fn agon_cpu_vsync() {
    unsafe {
        if let Some(st) = &*std::ptr::addr_of!(STATE) {
            st.gpios.b.set_input_pin(1, true);
            st.gpios.b.set_input_pin(1, false);
        }
    }
}
