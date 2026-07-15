import { MemoryService } from "@/services/Memory.service";
import {
  Interrupt,
  Peripheral,
  PeripheralSnapshot,
  PeripheralStatus,
} from "@/types/peripheral.types";

// ─── Control register addresses ────────────────────────────────────────────
export const REG = {
  CMD: 0x3f0, //                      CPU writes a command here
  SECTOR: 0x3f1, //                   CPU writes the target sector number here (0-15)
  OFFSET: 0x3f2, //                   CPU writes the byte offset within the sector here
  DATA: 0x3f3, //                     CPU writes or reads here
  STATUS: 0x3f4, //                   Drive writes its current state here so the CPU can check the ISR
};

// ─── CMD register values ───────────────────────────────────────────────────
export enum CMD {
  NOP = 0x00, //                      No operation - drive is idle
  READ = 0x01, //                     Read storage [sector][offset] into DATA register
  WRITE = 0x02, //                    Write DATA register into storage [sector][offset]
}

// ─── STATUS register values ────────────────────────────────────────────────
export enum STATUS {
  IDLE = 0x01, //                     Drive is ready to accept a command
  BUSY = 0x02, //                     Drive is seeking
  DONE = 0x03, //                     Last operation completed
  ERROR = 0x04, //                    Bad sector/offset
}

// ─── Disk Geometry ─────────────────────────────────────────────────────────
const SECTORS = 16; //                How many sectors the disk has
const BYTES_PER_SECTOR = 16; //       How many bytes fit in one sector. Total storage: 16 x 16 = 256bytes

const SEEK_TICKS = 2; //              Simulated seek latency so the BUSY state is visible in the UI

// ─── Meta type ─────────────────────────────────────────────────────────────
export type HardDriveMeta = {
  type: string;
  sectors: number;
  bytesPerSector: number;
  storage: number[][];
  cmdAddress: number;
  sectorAddress: number;
  offsetAddress: number;
  dataAddress: number;
  statusAddress: number;
  currentSector: number;
  currentOffset: number;
  currentCmd: number;
  driveStatus: number;
  currentData: number;
};

export class HardDrive implements Peripheral<HardDriveMeta> {
  readonly id: string;
  readonly name: string;
  priority: number;
  status: PeripheralStatus;

  private handlerAddress: number;
  private readonly memory: MemoryService;

  // Array of bytes indexed [sector][offset]
  private storage: number[][];

  /*
  Countdown timer for simulated seek delay.
  Set to SEEK_TICKS when a command starts.
  Reaches 0 when operation executes.
  */
  private busyCounter: number = 0;

  // Stores the current command to be executed once busyCounter expires.
  private pendingCmd: number = CMD.NOP;

  constructor(
    id: string,
    name: string,
    handlerAddress: number = 0x00d0, // Default ISR address

    priority: number = 2, // Medium priority by default
    memory: MemoryService,
  ) {
    this.id = id;
    this.name = name;
    this.handlerAddress = handlerAddress;
    this.priority = priority;
    this.status = PeripheralStatus.DISCONNECTED;
    this.memory = memory;

    // Build the 16x16 storage grid.
    this.storage = Array.from({ length: SECTORS }, () =>
      new Array(BYTES_PER_SECTOR).fill(0),
    );
  }

  connect(): void {
    if (this.status === PeripheralStatus.DISCONNECTED) {
      this.status = PeripheralStatus.IDLE;
      this.memory.write(REG.CMD, CMD.NOP); //          Drive starts with no pending command.
      this.memory.write(REG.STATUS, STATUS.IDLE); //   Reports itself as idle.
    }
  }

  disconnect(): void {
    this.status = PeripheralStatus.DISCONNECTED;
  }

  trigger(): void {
    this.busyCounter = 0; //                          Cancel any seek in progress.
    this.pendingCmd = CMD.NOP; //                     Clear any pending command.
    this.memory.write(REG.CMD, CMD.NOP); //           Clear the command register.
    this.memory.write(REG.STATUS, STATUS.IDLE); //    Report idle to the CPU
  }

  tick(): Interrupt | null {
    // If the hard drive is disconnected, do nothing.
    if (this.status === PeripheralStatus.DISCONNECTED) return null;

    // CASE 1: If the hard drive is seeking:
    if (this.busyCounter > 0) {
      // Count down one tick closer to completion.
      this.busyCounter--;

      // Still seeking: do nothing.
      if (this.busyCounter > 0) return null;
      // No longer seeking, run the command.
      return this.executeCommand(this.pendingCmd);
    }

    // CASE 2: The hard drive is idle, check for a command.
    const cmd = this.memory.read(REG.CMD);

    // No command has been issued: do nothing.
    if (cmd === CMD.NOP) {
      this.memory.write(REG.STATUS, STATUS.IDLE);
      this.status = PeripheralStatus.IDLE;
      return null;
    }

    // Validate the sector and offset. If either one is out of
    // range, flag an error.
    const sector = this.memory.read(REG.SECTOR);
    const offset = this.memory.read(REG.OFFSET);
    if (sector >= SECTORS || offset >= BYTES_PER_SECTOR) {
      this.memory.write(REG.STATUS, STATUS.ERROR);
      this.memory.write(REG.CMD, CMD.NOP);
      return null;
    }

    // CASE 3: Start a new seek.
    this.pendingCmd = cmd;
    this.busyCounter = SEEK_TICKS; //                 Start the countdown.
    this.memory.write(REG.STATUS, STATUS.BUSY); //    Tell the CPU the hard drive is busy.
    this.status = PeripheralStatus.ACTIVE; //         Set peripheral to active.
    return null;
  }

  // Executes a READ or WRITE after the seek delay has completed.
  // Returns an Interrupt to notify the CPU that the operation is complete.
  private executeCommand(cmd: number): Interrupt | null {
    // Read the registers.
    const sector = this.memory.read(REG.SECTOR);
    const offset = this.memory.read(REG.OFFSET);

    if (cmd === CMD.READ) {
      // Copy from internal storage into DATA register.
      this.memory.write(REG.DATA, this.storage[sector][offset]);
    } else if (cmd === CMD.WRITE) {
      // Copy from DATA register into internal storage.
      this.storage[sector][offset] = this.memory.read(REG.DATA);
    }

    // Update registers and reset internal state.
    this.memory.write(REG.STATUS, STATUS.DONE); //    Tell CPU operation is completed.
    this.memory.write(REG.CMD, CMD.NOP); //           Clear the command.
    this.pendingCmd = CMD.NOP;
    this.status = PeripheralStatus.IDLE; //           Set peripheral to idle.

    // Interrupt
    return {
      source: this.id,
      priority: this.priority,
      handlerAddress: this.handlerAddress,
      timestamp: Date.now(),
    };
  }

  // Direct UI write / CPU bypass
  writeCell(sector: number, offset: number, value: number): void {
    if (sector < SECTORS && offset < BYTES_PER_SECTOR) {
      this.storage[sector][offset] = value & 0xff; // & 0xFF clamps to one byte (0–255)
    }
  }

  toJSON(): PeripheralSnapshot<HardDriveMeta> {
    return {
      id: this.id,
      name: this.name,
      priority: this.priority,
      status: this.status,
      handlerAddress: this.handlerAddress,
      meta: {
        type: "hard-drive",
        sectors: SECTORS,
        bytesPerSector: BYTES_PER_SECTOR,
        storage: this.storage.map((row) => [...row]),
        // UI Display
        cmdAddress: REG.CMD,
        sectorAddress: REG.SECTOR,
        offsetAddress: REG.OFFSET,
        dataAddress: REG.DATA,
        statusAddress: REG.STATUS,
        // Live register values
        currentSector: this.memory.read(REG.SECTOR),
        currentOffset: this.memory.read(REG.OFFSET),
        currentCmd: this.memory.read(REG.CMD),
        driveStatus: this.memory.read(REG.STATUS),
        currentData: this.memory.read(REG.DATA),
      },
    };
  }
}
