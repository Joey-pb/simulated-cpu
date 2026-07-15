/**
 * Phase 4b verification — Peripherals (Button, Timer, Sensor, PeripheralManager, CPU integration)
 * Run: npx tsx scripts/test-peripherals.ts
 */
import { MemoryService } from "@/services/Memory.service";
import { CPUService } from "@/services/cpu/CPU.service";
import { PeripheralManager } from "@/services/PeripheralManager.service";
import ButtonPeripheral from "@/peripherals/Button.peripheral";
import TimerPeripheral from "@/peripherals/Timer.peripheral";
import { SensorPeripheral } from "@/peripherals/Sensor.peripheral";
import { PotentiometerPeripheral } from "@/peripherals/Potentiometer.peripheral";
import { LEDPeripheral } from "@/peripherals/LED.peripheral";
import { PeripheralStatus } from "@/types/peripheral.types";
import { HardDrive, CMD } from "@/peripherals/HardDrive.peripheral";

function header(title: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(60)}`);
}

function assert(condition: boolean, label: string) {
  console.log(condition ? `  ✅ ${label}` : `  ❌ ${label}`);
  if (!condition) process.exitCode = 1;
}

// ─── 1. Button Peripheral ───────────────────────────────────────────────────

header("1. Button — trigger & tick");

const btn = new ButtonPeripheral("btn1", "Red Button", 0x100, 0);

assert(btn.status === PeripheralStatus.DISCONNECTED, "starts DISCONNECTED");
assert(btn.tick() === null, "tick while disconnected → null");

btn.connect();
assert(btn.status === PeripheralStatus.IDLE, "after connect → IDLE");
assert(btn.tick() === null, "tick without trigger → null");

btn.trigger();
assert(btn.status === PeripheralStatus.ACTIVE, "after trigger → ACTIVE");

const btnInt = btn.tick();
assert(btnInt !== null, "tick after trigger → interrupt");
assert(btnInt!.source === "btn1", "interrupt source = btn1");
assert(btnInt!.priority === 0, "interrupt priority = 0");
assert(btnInt!.handlerAddress === 0x100, "handler address = 0x100");
assert(btn.status === PeripheralStatus.IDLE, "after firing → back to IDLE");

assert(btn.tick() === null, "second tick without trigger → null (one-shot)");

btn.disconnect();
assert(
  btn.status === PeripheralStatus.DISCONNECTED,
  "after disconnect → DISCONNECTED",
);

// ─── 2. Button — toJSON ────────────────────────────────────────────────────

header("2. Button — toJSON");

btn.connect();
btn.trigger();
const snap = btn.toJSON();
assert(snap.id === "btn1", "snapshot id");
assert(snap.name === "Red Button", "snapshot name");
assert(snap.priority === 0, "snapshot priority");
assert(snap.handlerAddress === 0x100, "snapshot handlerAddress");
assert(
  (snap.meta as { armed: boolean }).armed === true,
  "snapshot meta.armed = true",
);
btn.disconnect();

// ─── 3. Timer Peripheral ───────────────────────────────────────────────────

header("3. Timer — periodic interrupts");

const timer = new TimerPeripheral("tmr1", "System Timer", 0x200, 3, 2);

timer.connect();

// Ticks 1, 2 → no fire (interval=3)
assert(timer.tick() === null, "tick 1 → null");
assert(timer.tick() === null, "tick 2 → null");

// Tick 3 → fires
const tmrInt = timer.tick();
assert(tmrInt !== null, "tick 3 → interrupt");
assert(tmrInt!.source === "tmr1", "timer interrupt source");
assert(tmrInt!.priority === 2, "timer priority = 2");
assert(tmrInt!.handlerAddress === 0x200, "timer handler address");

// Counter resets, ticks 4, 5 → no fire
assert(timer.tick() === null, "tick 4 → null (counter reset)");
assert(timer.tick() === null, "tick 5 → null");

// Tick 6 → fires again
assert(timer.tick() !== null, "tick 6 → interrupt (second period)");

// ─── 4. Timer — forceFire via trigger ───────────────────────────────────────

header("4. Timer — trigger forces immediate fire");

timer.tick(); // tick 7 → counter=1
timer.trigger();
const forcedInt = timer.tick(); // tick 8 → should fire due to forceFire
assert(forcedInt !== null, "trigger forces fire on next tick");
assert(timer.getCounter() === 0, "counter reset after forced fire");

// ─── 5. Timer — configuration ──────────────────────────────────────────────

header("5. Timer — setInterval");

timer.setInterval(2);
assert(timer.getInterval() === 2, "interval changed to 2");
assert(timer.tick() === null, "tick after setInterval → counter=1, no fire");
assert(timer.tick() !== null, "tick → counter=2, fires");

let tmrCaught = false;
try {
  new TimerPeripheral("x", "x", 0, 0);
} catch {
  tmrCaught = true;
}
assert(tmrCaught, "interval=0 throws RangeError");

timer.disconnect();

// ─── 6. Sensor Peripheral ──────────────────────────────────────────────────

header("6. Sensor — threshold crossing");

const sensor = new SensorPeripheral("sns1", "Temp Sensor", 0x300, 100, 3);

sensor.connect();

// Value below threshold → no fire
sensor.setValue(50);
assert(sensor.tick() === null, "value=50, threshold=100 → null");

// Value crosses above threshold (rising edge)
sensor.setValue(101);
const snsInt = sensor.tick();
assert(snsInt !== null, "value=101 crosses threshold → interrupt");
assert(snsInt!.source === "sns1", "sensor interrupt source");
assert(snsInt!.handlerAddress === 0x300, "sensor handler address");

// Value stays above → no re-fire (already crossed)
sensor.setValue(150);
assert(sensor.tick() === null, "stays above threshold → no re-fire");

// Value drops below then rises again → fires
sensor.setValue(80);
sensor.tick(); // process the drop
sensor.setValue(120);
const snsInt2 = sensor.tick();
assert(snsInt2 !== null, "re-crosses threshold → fires again");

// ─── 7. Sensor — trigger & setThreshold ─────────────────────────────────────

header("7. Sensor — trigger & setThreshold");

sensor.setValue(50); // below threshold (100)
sensor.tick();
sensor.trigger();
const forcedSns = sensor.tick();
assert(forcedSns !== null, "trigger forces fire regardless of value");

sensor.setThreshold(200);
assert(sensor.getThreshold() === 200, "threshold changed to 200");

sensor.disconnect();

// ─── 8. Potentiometer Peripheral ───────────────────────────────────────────

header("8. Potentiometer — value change debounce + normalization");

const potMem = new MemoryService();
const pot = new PotentiometerPeripheral(
  "pot1",
  "Dial",
  0x320,
  100,
  2,
  potMem,
  0x003a,
  2,
);

pot.connect();
pot.setResistance(50);

assert(pot.tick() === null, "tick 1 after value change → debounced");
const potInt = pot.tick();
assert(potInt !== null, "tick 2 after value change → interrupt");
assert(potInt!.source === "pot1", "potentiometer interrupt source");
assert(potInt!.handlerAddress === 0x320, "potentiometer handler address");
assert(
  potMem.read(0x003a) === 128,
  "normalized 50/100 mapped to 128 in register",
);

pot.setResistance(50);
assert(pot.tick() === null, "same value does not queue new interrupt");

pot.setMaxResistance(200);
pot.setResistance(100);
pot.tick();
assert(
  pot.tick() !== null,
  "new value after max change still fires with debounce",
);
assert(
  pot.getNormalizedValue() === 128,
  "normalized remains half-scale at 100/200",
);

pot.disconnect();

// ─── 9. LED Peripheral ─────────────────────────────────────────────────────

header("9. LED — memory-driven output without interrupts");

const ledMem = new MemoryService();
ledMem.write(0x003a, 200);
const led = new LEDPeripheral(
  "led1",
  "Status LED",
  0,
  "#22c55e",
  ledMem,
  0x003a,
);

led.connect();
const ledInt = led.tick();
assert(ledInt === null, "LED tick never emits interrupts");
assert(
  led.getCurrentMa() > 10,
  "LED enters high-current state on high output entry",
);
assert(led.getBrightness() > 180, "LED brightness rises with high current");

ledMem.write(0x003a, 20);
led.tick();
assert(
  led.getCurrentMa() < 5,
  "LED enters low-current state on low output entry",
);
assert(led.getBrightness() < 80, "LED brightness drops with low current");

assert(
  (led.toJSON().meta.color as string) === "#22c55e",
  "LED snapshot keeps create-time color",
);

led.disconnect();

// ─── 10. PeripheralManager — registry ───────────────────────────────────────

header("10. PeripheralManager — register, connect, tickAll");

const mgr = new PeripheralManager();
const b = new ButtonPeripheral("btn-a", "Button A", 0x100, 0);
const t = new TimerPeripheral("tmr-a", "Timer A", 0x200, 2, 1);

mgr.register(b);
mgr.register(t);
assert(mgr.size === 2, "2 peripherals registered");
assert(mgr.has("btn-a"), "has btn-a");

// Connect both
mgr.connect("btn-a");
mgr.connect("tmr-a");
assert(mgr.getConnected().length === 2, "2 connected");

// Trigger button, tick all
mgr.trigger("btn-a");
const interrupts1 = mgr.tickAll();
assert(
  interrupts1.length === 1,
  "tickAll: 1 interrupt (button fired, timer counter=1)",
);
assert(interrupts1[0].source === "btn-a", "interrupt from button");

// Tick again → timer at counter=2 → fires
const interrupts2 = mgr.tickAll();
assert(
  interrupts2.length === 1,
  "tickAll: 1 interrupt (timer fires at interval=2)",
);
assert(interrupts2[0].source === "tmr-a", "interrupt from timer");

// Unregister
mgr.unregister("btn-a");
assert(mgr.size === 1, "1 peripheral after unregister");
assert(!mgr.has("btn-a"), "btn-a removed");

// Duplicate registration throws
let dupCaught = false;
try {
  mgr.register(t);
} catch {
  dupCaught = true;
}
assert(dupCaught, "duplicate register throws");

// ─── 11. PeripheralManager — events ────────────────────────────────────────

header("11. PeripheralManager — event listener");

const mgr2 = new PeripheralManager();
const events: string[] = [];
mgr2.onEvent((e) => events.push(e.type));

const b2 = new ButtonPeripheral("btn-b", "Button B", 0x100, 0);
mgr2.register(b2);
mgr2.connect("btn-b");
mgr2.trigger("btn-b");
mgr2.disconnect("btn-b");
mgr2.unregister("btn-b");

assert(events.length === 5, "5 events fired");
assert(events[0] === "registered", "event 1: registered");
assert(events[1] === "connected", "event 2: connected");
assert(events[2] === "triggered", "event 3: triggered");
assert(events[3] === "disconnected", "event 4: disconnected");
assert(events[4] === "unregistered", "event 5: unregistered");

// ─── 12. PeripheralManager — toJSON ────────────────────────────────────────

header("12. PeripheralManager — toJSON");

const mgr3 = new PeripheralManager();
mgr3.register(new ButtonPeripheral("snap-btn", "Snap Button", 0x100, 0));
mgr3.register(new TimerPeripheral("snap-tmr", "Snap Timer", 0x200, 5, 1));
const snapshots = mgr3.toJSON();
assert(snapshots.length === 2, "toJSON returns 2 snapshots");
assert(snapshots[0].id === "snap-btn", "first snapshot is button");
assert(snapshots[1].id === "snap-tmr", "second snapshot is timer");

// ─── 13. CPU + Peripheral Integration ──────────────────────────────────────

header("13. CPU + Peripheral — button interrupt dispatched via tick");

/**
 * Main program at 0x000: LOAD R0, 0x080 (=42), then infinite JMP loop
 * ISR at 0x100: LOAD R1, 0x081 (=77), IRET
 * Data: mem[0x080]=42, mem[0x081]=77
 *
 * We tick the CPU a few times, then trigger the button and tick again
 * to verify the interrupt gets dispatched through the full pipeline.
 */
const cpuMem = new MemoryService();
cpuMem.write(0x080, 42);
cpuMem.write(0x081, 77);

// Main program: LOAD R0, JMP 0x004 (spin loop)
cpuMem.loadProgram(0x000, [
  0x01,
  0x00,
  0x00,
  0x80, // LOAD R0, 0x080
  0x05,
  0x00,
  0x00,
  0x04, // JMP 0x004
]);

// ISR at 0x100
cpuMem.loadProgram(0x100, [
  0x01,
  0x01,
  0x00,
  0x81, // LOAD R1, 0x081
  0xfe,
  0x00,
  0x00,
  0x00, // IRET
]);

const cpu = new CPUService(cpuMem);
const cpuBtn = new ButtonPeripheral("cpu-btn", "CPU Button", 0x100, 0);
cpu.registerPeripheral(cpuBtn);
cpu.connectPeripheral("cpu-btn");

// Tick 1: both cores execute LOAD R0 (PC was 0x000)
let ev = cpu.step();
assert(ev.interruptsFired === 0, "tick 1: no interrupts fired");
assert(ev.coreStates[0].registers.R0 === 42, "tick 1: core0 R0 = 42");

// Tick 2: cores in JMP loop
ev = cpu.step();
assert(ev.interruptsFired === 0, "tick 2: still no interrupts");

// Trigger button — it will fire on the NEXT peripheral tick
cpu.triggerPeripheral("cpu-btn");

// Tick 3: peripheral ticks, button interrupt dispatched, then cores execute
ev = cpu.step();
assert(
  ev.interruptsFired >= 1,
  `tick 3: ≥1 interrupt fired (got ${ev.interruptsFired})`,
);

// After the ISR executes (LOAD R1 + IRET will take 2 more ticks), verify the interrupt was handled
// For now, just confirm the system didn't crash and the interrupt was dispatched
console.log(
  `  Cycle ${ev.cycle}: interruptsFired=${ev.interruptsFired}, pending=${ev.pendingInterrupts}`,
);

// ─── 14. CPU + Hard Drive — write via memory-mapped registers ──────────────

header("14. Hard Drive — CPU-driven WRITE");

const hdMem = new MemoryService();
hdMem.write(0x080, 3); //     sector
hdMem.write(0x081, 5); //     offset
hdMem.write(0x082, 0x42); //  value to write
hdMem.write(0x083, CMD.WRITE);

// prettier-ignore
hdMem.loadProgram(0x000, [
  0x01, 0x00, 0x00, 0x80, // LOAD  R0, 0x080   R0 = sector
  0x02, 0x00, 0x03, 0xf1, // STORE R0, 0x3F1   SECTOR
  0x01, 0x01, 0x00, 0x81, // LOAD  R1, 0x081   R1 = offset
  0x02, 0x01, 0x03, 0xf2, // STORE R1, 0x3F2   OFFSET
  0x01, 0x02, 0x00, 0x82, // LOAD  R2, 0x082   R2 = value
  0x02, 0x02, 0x03, 0xf3, // STORE R2, 0x3F3   DATA
  0x01, 0x03, 0x00, 0x83, // LOAD  R3, 0x083   R3 = CMD.WRITE
  0x02, 0x03, 0x03, 0xf0, // STORE R3, 0x3F0   CMD  ← triggers seek
  0xff, 0x00, 0x00, 0x00, // HALT
]);

const hdCpu = new CPUService(hdMem);
const drive = new HardDrive("hd1", "Hard Drive", 0x00d0, 2, hdMem);
hdCpu.registerPeripheral(drive);
hdCpu.connectPeripheral("hd1");

// Run until the drive reports completion via its interrupt
let hdCompleted = false;
for (let i = 0; i < 15 && !hdCompleted; i++) {
  const ev = hdCpu.step();
  if (ev.interruptSources.includes("hd1")) hdCompleted = true;
}

assert(hdCompleted, "hd1 fired a completion interrupt");
assert(
  (drive.toJSON().meta.storage as number[][])[3][5] === 0x42,
  "storage[3][5] = 0x42",
);

// ─── Done ───────────────────────────────────────────────────────────────────

header("All Peripheral tests complete ✓");
