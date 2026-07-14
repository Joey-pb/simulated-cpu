/**
 * @module ButtonPeripheral
 *
 * Concrete {@link Peripheral} implementation: a momentary push-button.
 * Pressing (`trigger()`) arms it; the next tick fires one interrupt then
 * automatically disarms.
 */

import {
  PeripheralStatus,
  type Peripheral,
  type Interrupt,
  type PeripheralSnapshot,
} from "@/types/peripheral.types";

// ─── Button Peripheral ──────────────────────────────────────────────────────

/**
 * A simple push-button peripheral.
 *
 * - `trigger()` arms the button; the next `tick()` fires a single interrupt
 *   then disarms automatically.
 * - The button must be connected to the CPU to have any effect.
 */
export default class ButtonPeripheral implements Peripheral {
  readonly id: string;
  readonly name: string;
  priority: number;
  status: PeripheralStatus;

  private handlerAddress: number;
  private armed: boolean;

  constructor(
    id: string,
    name: string,
    handlerAddress: number,
    priority: number = 0
  ) {
    this.id = id;
    this.name = name;
    this.handlerAddress = handlerAddress;
    this.priority = priority;
    this.status = PeripheralStatus.DISCONNECTED;
    this.armed = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  connect(): void {
    if (this.status === PeripheralStatus.DISCONNECTED) {
      this.status = PeripheralStatus.IDLE;
    }
  }

  disconnect(): void {
    this.status = PeripheralStatus.DISCONNECTED;
    this.armed = false;
  }

  // ── Trigger (user presses the button) ────────────────────────────────

  trigger(): void {
    if (this.status === PeripheralStatus.DISCONNECTED) return;
    this.armed = true;
    this.status = PeripheralStatus.ACTIVE;
  }

  // ── Tick ──────────────────────────────────────────────────────────────

  tick(): Interrupt | null {
    if (this.status === PeripheralStatus.DISCONNECTED) return null;

    if (this.armed) {
      this.armed = false;
      this.status = PeripheralStatus.IDLE;
      return {
        source: this.id,
        priority: this.priority,
        handlerAddress: this.handlerAddress,
        timestamp: Date.now(),
      };
    }

    return null;
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
        type: "button",
        armed: this.armed,
      },
    };
  }
}
