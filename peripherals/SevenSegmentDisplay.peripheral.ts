import { MemoryService } from "@/services/Memory.service";
import {
  PeripheralStatus,
  type Peripheral,
  type Interrupt,
  type PeripheralSnapshot,
} from "@/types/peripheral.types";

export class SevenSegmentDisplay implements Peripheral {
  readonly id: string;
  readonly name: string;
  priority: number;
  status: PeripheralStatus;
  values: [
    number | undefined,
    number | undefined,
    number | undefined,
    number | undefined,
    number | undefined,
    number | undefined,
    number | undefined,
    number | undefined,
    number | undefined,
    number | undefined
  ] | undefined;
  private handlerAddress: number;
  private readonly memory: MemoryService;

  /**
   * Memory address the screen samples each tick.
   * Defaults to 0x0038 — the proximity sensor's register.
   */
  private sourceAddress: number;


  constructor(
    id: string,
    name: string,
    handlerAddress: number = 0,
    sourceAddress: number = 0x0038,
    memory: MemoryService,
  ) {
    this.id = id;
    this.name = name;
    this.handlerAddress = handlerAddress;
    this.priority = 0; // never fires — priority irrelevant
    this.status = PeripheralStatus.DISCONNECTED;

    this.memory = memory;
    this.sourceAddress = sourceAddress;
    this.initValue();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  connect(): void {
    if (this.status === PeripheralStatus.DISCONNECTED) {
      this.status = PeripheralStatus.IDLE;
    }
  }

  disconnect(): void {
    this.status = PeripheralStatus.DISCONNECTED;
  }

  // ── Configuration ─────────────────────────────────────────────────────

  setSourceAddress(address: number): void {
    this.sourceAddress = address;
  }

  /** Clear all pixels to 0 (off). */
  clearScreen(): void {
    this.initValue();
  }

  // ── Trigger ───────────────────────────────────────────────────────────

  /** Trigger clears the screen. */
  trigger(): void {
    this.clearScreen();
  }

  // ── Tick — the auto-scroll engine ─────────────────────────────────────

  /**
   * Each qualifying tick:
   * 1. Read one byte from `sourceAddress`.
   * 2. Shift every column left by one (oldest data falls off).
   * 3. Draw a new rightmost column whose filled height is proportional
   *    to the sampled value (0 = empty, 255 = full height).
   *
   * The screen never generates interrupts — always returns `null`.
   */
  tick(): Interrupt | null {
    if (this.status === PeripheralStatus.DISCONNECTED) return null;

    this.status = PeripheralStatus.ACTIVE;

    // 1. Sample the source — invert so that low distance (close) = tall bar,
    //    high distance (far) = empty.  A raw value of 255 means "far away"
    //    and should produce an empty column (dark background).
    const raw = this.memory.read(this.sourceAddress);

    const finalValue = raw.toString();

    this.values = finalValue.split("").map(Number).slice(0, 10) as typeof this.values;

    this.status = PeripheralStatus.IDLE;
    return null;
  }

  private initValue() {
    this.values = [] as unknown as typeof this.values;
  }

  // ── Serialisation ─────────────────────────────────────────────────────
  toJSON(): PeripheralSnapshot {
    return {
      id: this.id,
      name: this.name,
      priority: this.priority,
      status: this.status,
      handlerAddress: this.handlerAddress,
      meta: {
        type: "seven-segment-display",
        sourceAddress: this.sourceAddress,
        values: this.values,
        pixels: true,
        width: true
      },
    };
  }
}
