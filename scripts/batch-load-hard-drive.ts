/**
 *
 * Sends a list of write commands to the HardDrive peripheral over the
 * WebSocket, one at a time, waiting for each write's completion interrupt
 * before sending the next.
 *
 * First run `npm run dev: all` then run `npx tsx scripts/batch-load-hard-drive.ts`
 *
 */

import WebSocket from "ws";
import { REG, CMD } from "@/peripherals/HardDrive.peripheral";
import { PeripheralConfig } from "@/peripherals/registry";

// ─── Peripheral constants ─────────────────────────────────────────────────

const DRIVE_ID = "hd1";
const DRIVE_ISR = 0x00d0; // ISR address.

const SCRATCH = 0x0200; // Begin scratch data.
const CODE = 0x0000; // Begin CPU instructions.

// ─── Clock & timing ───────────────────────────────────────────────────────

const CLOCK_MS = 10; // Milliseconds per CPU cycle.

/**
 * Cycles the drive spends BUSY seeking before it performs the read/write
 * and fires its completion interrupt. Mirrors SEEK_TICKS in
 * HardDrive.peripheral.ts — update both together if the drive changes.
 */
const SEEK_TICKS = 2;

/**
 * Extra cycles of headroom added to each timeout to absorb scheduler
 * dispatch, interrupt delivery, and WebSocket round-trip jitter. Without
 * it, a write that completes normally could still trip the timeout on a
 * slow tick.
 */
const SLACK_TICKS = 4;

// ─── Types ────────────────────────────────────────────────────────────────

export interface WriteCommand {
  track: number;
  sector: number;
  offset: number;
  data: number;
}

interface Broadcast {
  type: "tick" | "state" | "error";
  cycle: number;
  interruptSources?: string[];
  memorySlice?: number[];
  message?: string;
}

enum OpCode {
  LOAD = 0x01,
  STORE = 0x02,
  HALT = 0xff,
}

// ─── Data to be written ───────────────────────────────────────────────────

// const WRITES: WriteCommand[] = [
//   { track: 0, sector: 0, offset: 0, data: 0xde },
//   { track: 0, sector: 0, offset: 1, data: 0xad },
//   { track: 0, sector: 1, offset: 0, data: 0xbe },
//   { track: 1, sector: 0, offset: 0, data: 0xef },
//   { track: 2, sector: 3, offset: 5, data: 0x42 },
// ];

const WRITES: WriteCommand[] = [];

const BYTE_COUNT = 16; // Number of bytes to write.
const SECTORS_PER_TRACK = 16; // mirrors the geometry in HardDrive.peripheral.ts
const BYTES_PER_SECTOR = 16;

for (let i = 0; i < BYTE_COUNT; i++) {
  const track = Math.floor(i / (SECTORS_PER_TRACK * BYTES_PER_SECTOR));
  const sector = Math.floor(i / BYTES_PER_SECTOR) % SECTORS_PER_TRACK;
  const offset = i % BYTES_PER_SECTOR;
  WRITES.push({ track, sector, offset, data: 0xde });
}

// ─── Assembler ────────────────────────────────────────────────────────────

const hi = (a: number) => (a >> 8) & 0xff;
const lo = (a: number) => a & 0xff;

// prettier-ignore
/**
 * Build scratch data + program for one write. Loads track/sector/offset/data
 * into R0–R3, stores each to its drive register, then reuses R0 for CMD.WRITE.
 */
function assembleWrite(cmd: WriteCommand): { data: number[]; code: number[] } {
  const data = [cmd.track, cmd.sector, cmd.offset, cmd.data, CMD.WRITE];
  const code = [
    /** 
    * 
    * [OPCODE, REGISTER, ADDRESS_HIGH, ADDRESS_LOW]
    * 
    */
    OpCode.LOAD,   0x00,   hi(SCRATCH + 0),  lo(SCRATCH + 0),      // LOAD R0, track
    OpCode.STORE,  0x00,   hi(REG.TRACK),    lo(REG.TRACK),        // STORE RO, TRACK
    OpCode.LOAD,   0x01,   hi(SCRATCH + 1),  lo(SCRATCH + 1),      // LOAD R1, sector
    OpCode.STORE,  0x01,   hi(REG.SECTOR),   lo(REG.SECTOR),       // STORE R1, SECTOR
    OpCode.LOAD,   0x02,   hi(SCRATCH + 2),  lo(SCRATCH + 2),      // LOAD R2, offset
    OpCode.STORE,  0x02,   hi(REG.OFFSET),   lo(REG.OFFSET),       // STORE R2, OFFSET
    OpCode.LOAD,   0x03,   hi(SCRATCH + 3),  lo(SCRATCH + 3),      // LOAD R3, data
    OpCode.STORE,  0x03,   hi(REG.DATA),     lo(REG.DATA),         // STORE R3, DATA
    OpCode.LOAD,   0x00,   hi(SCRATCH + 4),  lo(SCRATCH + 4),      // LOAD R0, CMD <- triggers seek
    OpCode.STORE,  0x00,   hi(REG.CMD),      lo(REG.CMD),
    OpCode.HALT,   0x00,   0x00,             0x00,                 // HALT
  ];

  return { data, code };
}

// ─── Batch runner ─────────────────────────────────────────────────────────

class HardDriveBatchRunner {
  private ws: WebSocket;
  private queue: WriteCommand[];
  private index = 0;
  private waiting = false;

  private timer: NodeJS.Timeout | null = null;
  private onDone: () => void;

  constructor(url: string, queue: WriteCommand[], onDone: () => void) {
    this.ws = new WebSocket(url);
    this.queue = queue;
    this.onDone = onDone;

    this.ws.on("open", () => this.handleOpen());
    this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
    this.ws.on("close", () => console.log("[batch] connection closed."));
    this.ws.on("error", (e) =>
      console.error("[batch] socket error: ", e.message),
    );
  }

  private send(payload: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(payload));
  }

  private handleOpen(): void {
    console.log(`[batch] connected - ${this.queue.length} writes queued.`);

    /**
     * Start clean then register the drive.
     */
    this.send({ type: "reset" });
    this.send({
      type: "registerPeripheral",
      peripheralType: "hard-drive",
      id: DRIVE_ID,
      name: "Hard Drive",
      handlerAddress: DRIVE_ISR,
      priority: 2,
    } as PeripheralConfig);

    this.send({ type: "setClockSpeed", ms: CLOCK_MS });
    this.runNext();
  }

  private runNext(): void {
    if (this.index >= this.queue.length) {
      console.log("[batch] ✅ all writes complete ");
      this.send({ type: "stop" });
      this.clearTimer();
      this.onDone();
      return;
    }

    const cmd = this.queue[this.index];
    const label =
      `[${this.index + 1}/${this.queue.length}]` +
      `t${cmd.track} s${cmd.sector} o${cmd.offset} <- 0x${cmd.data.toString(16).padStart(2, "0")}`;
    console.log(`[batch] writing ${label}`);

    const { data, code } = assembleWrite(cmd);
    const ticks = code.length / 4 + SEEK_TICKS + SLACK_TICKS;
    this.send({ type: "loadProgram", startAddress: SCRATCH, bytes: data });
    this.send({ type: "loadProgram", startAddress: CODE, bytes: code });
    this.send({
      type: "addProcess",
      name: `hdd-write-${this.index + 1}`,
      programStart: CODE,
      programLength: code.length,
    });
    this.send({ type: "start" });

    this.waiting = true;
    this.armTimeout(label, ticks * CLOCK_MS + 500);
  }

  private handleMessage(raw: string): void {
    let msg: Broadcast;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "error") {
      console.warn("[batch] server: ", msg.message);
      return;
    }

    if (!this.waiting) return;

    /**
     * Interrupt: write finished.
     */
    if (msg.interruptSources?.includes(DRIVE_ID)) {
      console.log(`[batch] ✅ completion interrupt at cycle ${msg.cycle}`);
      this.waiting = false;
      this.clearTimer();
      this.index++;
      setTimeout(() => this.runNext(), 0);
    }
  }

  private armTimeout(label: string, ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      console.error(
        `[batch] TIMEOUT waiting for ${label} at ${ms}ms - is the drive connected?`,
      );
      this.send({ type: "stop" });
      this.ws.close();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  close(): void {
    this.clearTimer();
    this.ws.close();
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────

const runner = new HardDriveBatchRunner("ws://localhost:3006", WRITES, () =>
  runner.close(),
);
