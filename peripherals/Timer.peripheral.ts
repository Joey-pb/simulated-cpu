/**
 * @module TimerPeripheral
 *
 * Concrete {@link Peripheral} implementation: a periodic countdown timer.
 * Fires an interrupt every `interval` ticks while connected.
 */

import {
  PeripheralStatus,
  type Peripheral,
  type Interrupt,
  type PeripheralSnapshot,
} from "@/types/peripheral.types";

// ─── Timer Peripheral ───────────────────────────────────────────────────────

/**
 * A periodic timer that fires an interrupt every `interval` ticks.
 *
 * - `trigger()` forces an immediate fire on the next tick (resets counter).
 * - The timer must be connected to have any effect.
 */
export default class TimerPeripheral implements Peripheral {
  readonly id: string;
  readonly name: string;
  priority: number;
  status: PeripheralStatus;

  private handlerAddress: number;
  private interval: number;
  private counter: number;
  private forceFire: boolean;

  constructor(
    id: string,
    name: string,
    handlerAddress: number,
    interval: number,
    priority: number = 2
  ) {
    if (interval <= 0) {
      throw new RangeError("Timer interval must be > 0");
    }
    this.id = id;
    this.name = name;
    this.handlerAddress = handlerAddress;
    this.interval = interval;
    this.priority = priority;
    this.status = PeripheralStatus.DISCONNECTED;
    this.counter = 0;
    this.forceFire = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  connect(): void {
    if (this.status === PeripheralStatus.DISCONNECTED) {
      this.status = PeripheralStatus.IDLE;
      this.counter = 0;
    }
  }

  disconnect(): void {
    this.status = PeripheralStatus.DISCONNECTED;
    this.counter = 0;
    this.forceFire = false;
  }

  // ── Trigger (force immediate fire) ────────────────────────────────────

  trigger(): void {
    if (this.status === PeripheralStatus.DISCONNECTED) return;
    this.forceFire = true;
  }

  // ── Tick ──────────────────────────────────────────────────────────────

  tick(): Interrupt | null {
    if (this.status === PeripheralStatus.DISCONNECTED) return null;

    this.counter++;

    const shouldFire = this.forceFire || this.counter >= this.interval;

    if (shouldFire) {
      this.counter = 0;
      this.forceFire = false;
      this.status = PeripheralStatus.ACTIVE;

      const interrupt: Interrupt = {
        source: this.id,
        priority: this.priority,
        handlerAddress: this.handlerAddress,
        timestamp: Date.now(),
      };

      // Return to idle after firing
      this.status = PeripheralStatus.IDLE;
      return interrupt;
    }

    this.status = PeripheralStatus.IDLE;
    return null;
  }

  // ── Configuration ─────────────────────────────────────────────────────

  getInterval(): number {
    return this.interval;
  }

  setInterval(interval: number): void {
    if (interval <= 0) throw new RangeError("Timer interval must be > 0");
    this.interval = interval;
  }

  getCounter(): number {
    return this.counter;
  }

  // ── Serialization ─────────────────────────────────────────────────────

  toJSON(): PeripheralSnapshot {
    return {
      id: this.id,
      name: this.name,
      priority: this.priority,
      status: this.status,
      handlerAddress: this.handlerAddress,
      meta: {
        type: "timer",
        interval: this.interval,
        counter: this.counter,
        forceFire: this.forceFire,
      },
    };
  }
}
