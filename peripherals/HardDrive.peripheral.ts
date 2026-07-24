/**
 * @module HardDrive
 *
 * Concrete {@link Peripheral} implementation: a memory-mapped simulated hard
 * disk with 16 tracks × 16 sectors × 16 bytes/sector (4 KiB total storage).
 *
 * **Command-register model:**
 * The CPU controls the drive entirely through six memory-mapped registers at
 * 0x3F0–0x3F5. To issue a command, the CPU writes the target TRACK, SECTOR,
 * and OFFSET into their respective registers, places any write payload in DATA,
 * then writes READ or WRITE into CMD. On the next tick the drive begins seeking.
 *
 * **Seek latency:**
 * After a command is issued, the drive spends `SEEK_TICKS` (2) ticks in the
 * BUSY state before executing the operation. This simulates mechanical seek
 * delay and keeps the BUSY state visible in the UI long enough to observe.
 *
 * **Interrupts:**
 * When an operation completes, the drive sets STATUS → DONE and fires a single
 * interrupt at the handler address. The CPU's ISR can then read the DATA
 * register for a READ result or verify that a WRITE completed. No ISR counter
 * is loaded for this peripheral type (no `dataAddress` in the registry entry).
 *
 * **Direct pre-load:**
 * {@link HardDrive.writeCell} bypasses the command-register flow and writes
 * directly into internal storage. The UI panel uses this to populate disk
 * contents without going through the CPU.
 */

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

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface DiskAddress {
  track: number,
  sector: number,
  offset: number,
}


export class HardDrive implements Peripheral<HardDriveMeta> {
  readonly id: string;
  readonly name: string;
  priority: number;
  status: PeripheralStatus;

  private handlerAddress: number;
  private readonly memory: MemoryService;

  // Flat disk storage.
  private diskStorage = new Uint8Array(TOTAL_BYTES);

  /**
   * Countdown timer for simulated seek delay.
   * Set to SEEK_TICKS when a command starts.
   * Reaches 0 when operation executes.
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
      this.setDriveState(STATUS.IDLE, CMD.NOP); //          Drive starts idle with no pending command.
    }
  }

  disconnect(): void {
    this.status = PeripheralStatus.DISCONNECTED;
  }

  trigger(): void {
    this.busyCounter = 0; //                          Cancel any seek in progress.
    this.setDriveState(STATUS.IDLE, CMD.NOP); //       Set status to idle, clear command register, clear pending command.
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

    /**
     * Validate the track, sector, and offset. If any are out of
     * range, flag an error.
     */
    const address = this.currentAddress;
    if (!this.isValidAddress(address)) {
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

  /**
   * Executes a READ or WRITE after the seek delay has completed.
   * Returns an Interrupt to notify the CPU that the operation is complete.
   */
  private executeCommand(cmd: number): Interrupt | null {
    // Read the registers.
    const address = this.currentAddress;

    if (cmd === CMD.READ) {
      // Copy from internal storage into DATA register.
      this.readDisk(address);
    } else if (cmd === CMD.WRITE) {
      // Copy from DATA register into internal storage.
      this.writeToDisk(address);
    }

    // Update registers and reset internal state.
    this.setDriveState(STATUS.DONE, CMD.NOP); //    Tell CPU operation is completed.

    // Interrupt
    return {
      source: this.id,
      priority: this.priority,
      handlerAddress: this.handlerAddress,
      timestamp: Date.now(),
    };
  }

  // ─── Helper Functions ─────────────────────────────────────────────────────────────

  private readDisk(address: DiskAddress): void {
    const index = this.getDiskIndex(address);
    const data = this.diskStorage[index];
    this.memory.write(REG.DATA, data);
  }

  private writeToDisk(address: DiskAddress): void {
    const index = this.getDiskIndex(address);
    const data = this.memory.read(REG.DATA);
    this.diskStorage[index] = data;
  }

  private getDiskIndex(address: DiskAddress): number {
    return (
      address.track * SECTORS_PER_TRACK * BYTES_PER_SECTOR + // Move to track.
      address.sector * BYTES_PER_SECTOR + //                    Move to sector.
      address.offset //                                         Move to offset.
    );
  }

  private setDriveState(status: STATUS, cmd: CMD = CMD.NOP): void {
    this.memory.write(REG.STATUS, status);
    this.memory.write(REG.CMD, cmd);
    this.pendingCmd = cmd;
  }

  private get currentAddress(): DiskAddress {
    return {
      track: this.memory.read(REG.TRACK),
      sector: this.memory.read(REG.SECTOR),
      offset: this.memory.read(REG.OFFSET),
    };
  }

  private isValidAddress(addr: DiskAddress): boolean {
    return (
      addr.track >= 0 &&
      addr.track < TRACK_COUNT &&
      addr.sector >= 0 &&
      addr.sector < SECTORS_PER_TRACK &&
      addr.offset >= 0 &&
      addr.offset < BYTES_PER_SECTOR
    );
  }

  private haltOnError(): void {
    this.setDriveState(STATUS.ERROR, CMD.NOP);
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
      const index = this.getDiskIndex({ track, sector, offset });
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
