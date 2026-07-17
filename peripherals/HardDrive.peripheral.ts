import { MemoryService } from "@/services/Memory.service";
import {
  Interrupt,
  Peripheral,
  PeripheralSnapshot,
  PeripheralStatus,
} from "@/types/peripheral.types";

// ─── Control register addresses ────────────────────────────────────────────
export const REG = {
  CMD: 0x3f0, //                      CPU writes a command here.
  TRACK: 0x3f1, //                    CPU writes the target track number here (0 -15).
  SECTOR: 0x3f2, //                   CPU writes the target sector number here (0-15).
  OFFSET: 0x3f3, //                   CPU writes the byte offset within the sector here (0-15).
  DATA: 0x3f4, //                     CPU writes or reads here.
  STATUS: 0x3f5, //                   Drive writes its current state here so the CPU can check the ISR.
};

// ─── CMD register values ───────────────────────────────────────────────────
export enum CMD {
  NOP = 0x00, //                      No operation - drive is idle.
  READ = 0x01, //                     Read storage in DATA register.
  WRITE = 0x02, //                    Write DATA register into storage.
}

// ─── STATUS register values ────────────────────────────────────────────────
export enum STATUS {
  IDLE = 0x01, //                     Drive is ready to accept a command.
  BUSY = 0x02, //                     Drive is seeking.
  DONE = 0x03, //                     Last operation completed.
  ERROR = 0x04, //                    Bad track/sector/offset.
}

// ─── Disk Geometry ─────────────────────────────────────────────────────────
// 16 tracks x 16 sectors x 16 bytes/sector = 4KiB hard disk.
const TRACK_COUNT = 16; //            How many tracks the disk has.
const SECTORS_PER_TRACK = 16; //      How many sectors the disk has.
const BYTES_PER_SECTOR = 16; //       How many bytes fit in one sector.

const TOTAL_BYTES = TRACK_COUNT * SECTORS_PER_TRACK * BYTES_PER_SECTOR;

const SEEK_TICKS = 2; //              Simulated seek latency so the BUSY state is visible in the UI.

// ─── Meta type ─────────────────────────────────────────────────────────────
export type HardDriveMeta = {
  type: string;
  trackCount: number;
  sectorsPerTrack: number;
  bytesPerSector: number;
  totalBytes: number;
  diskStorage: number[];
  cmdAddress: number;
  trackAddress: number;
  sectorAddress: number;
  offsetAddress: number;
  dataAddress: number;
  statusAddress: number;
  currentTrack: number;
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

  // Flat disk storage.
  private diskStorage = new Uint8Array(TOTAL_BYTES);

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
    handlerAddress: number = 0x00d0, // Default ISR address.
    priority: number = 2, // Medium priority by default.
    memory: MemoryService,
  ) {
    this.id = id;
    this.name = name;
    this.handlerAddress = handlerAddress;
    this.priority = priority;
    this.status = PeripheralStatus.DISCONNECTED;
    this.memory = memory;
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
    this.memory.write(REG.STATUS, STATUS.IDLE); //    Report idle to the CPU.
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

    /* 
    Validate the track, sector, and offset. If any are out of
    range, flag an error. 
    */
    const track = this.memory.read(REG.TRACK);
    const sector = this.memory.read(REG.SECTOR);
    const offset = this.memory.read(REG.OFFSET);
    if (
      track >= TRACK_COUNT ||
      sector >= SECTORS_PER_TRACK ||
      offset >= BYTES_PER_SECTOR
    ) {
      this.haltOnError();
      return null;
    }

    // CASE 3: Start a new seek.
    this.pendingCmd = cmd;
    this.busyCounter = SEEK_TICKS; //                 Start the countdown.
    this.memory.write(REG.STATUS, STATUS.BUSY); //    Tell the CPU the hard drive is busy.
    this.status = PeripheralStatus.ACTIVE; //         Set peripheral to active.
    return null;
  }

  /* 
  Executes a READ or WRITE after the seek delay has completed.
  Returns an Interrupt to notify the CPU that the operation is complete. 
  */
  private executeCommand(cmd: number): Interrupt | null {
    // Read the registers.
    const track = this.memory.read(REG.TRACK);
    const sector = this.memory.read(REG.SECTOR);
    const offset = this.memory.read(REG.OFFSET);

    if (cmd === CMD.READ) {
      // Copy from internal storage into DATA register.
      this.readDisk(track, sector, offset);
    } else if (cmd === CMD.WRITE) {
      // Copy from DATA register into internal storage.
      this.writeToDisk(track, sector, offset);
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

  private readDisk(track: number, sector: number, offset: number): void {
    const index = this.getDiskIndex(track, sector, offset);
    const data = this.diskStorage[index];
    this.memory.write(REG.DATA, data);
  }

  private writeToDisk(track: number, sector: number, offset: number): void {
    const index = this.getDiskIndex(track, sector, offset);
    const data = this.memory.read(REG.DATA);
    this.diskStorage[index] = data;
  }

  private getDiskIndex(track: number, sector: number, offset: number): number {
    return (
      track * SECTORS_PER_TRACK * BYTES_PER_SECTOR + // Move to track.
      sector * BYTES_PER_SECTOR + //                    Move to sector.
      offset //                                         Move to offset.
    );
  }

  private haltOnError(): void {
    this.memory.write(REG.STATUS, STATUS.ERROR);
    this.memory.write(REG.CMD, CMD.NOP);
  }

  // Direct UI write / CPU bypass
  writeCell(
    track: number,
    sector: number,
    offset: number,
    value: number,
  ): void {
    if (
      track < TRACK_COUNT &&
      sector < SECTORS_PER_TRACK &&
      offset < BYTES_PER_SECTOR
    ) {
      const index = this.getDiskIndex(track, sector, offset);
      this.diskStorage[index] = value & 0xff; // & 0xFF clamps to one byte (0–255).
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
        trackCount: TRACK_COUNT,
        sectorsPerTrack: SECTORS_PER_TRACK,
        bytesPerSector: BYTES_PER_SECTOR,
        totalBytes: TOTAL_BYTES,
        diskStorage: Array.from(this.diskStorage),
        // UI Display
        trackAddress: REG.TRACK,
        cmdAddress: REG.CMD,
        sectorAddress: REG.SECTOR,
        offsetAddress: REG.OFFSET,
        dataAddress: REG.DATA,
        statusAddress: REG.STATUS,
        // Live register values
        currentTrack: this.memory.read(REG.TRACK),
        currentSector: this.memory.read(REG.SECTOR),
        currentOffset: this.memory.read(REG.OFFSET),
        currentCmd: this.memory.read(REG.CMD),
        driveStatus: this.memory.read(REG.STATUS),
        currentData: this.memory.read(REG.DATA),
      },
    };
  }
}
