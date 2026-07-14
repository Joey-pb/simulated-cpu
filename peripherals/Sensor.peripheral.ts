/**
 * @module SensorPeripheral
 *
 * Concrete {@link Peripheral} implementation: a threshold-based analog sensor.
 * External code feeds values via `setValue()`; when the value crosses the
 * threshold an interrupt fires once (re-arms after dropping below).
 */

import {
  PeripheralStatus,
  type Peripheral,
  type Interrupt,
  type PeripheralSnapshot,
} from "@/types/peripheral.types";

// ─── Sensor Peripheral ──────────────────────────────────────────────────────

/**
 * A threshold-based sensor peripheral.
 *
 * External code feeds data via `setValue(n)`. When the value exceeds the
 * configured `threshold`, the sensor fires an interrupt on the next `tick()`.
 * The interrupt fires once per threshold crossing — the value must drop
 * below the threshold and rise above it again to fire another.
 *
 * - `trigger()` forces an immediate fire on the next tick regardless of value.
 * - The sensor must be connected to have any effect.
 */
export class SensorPeripheral implements Peripheral {
  readonly id: string;
  readonly name: string;
  priority: number;
  status: PeripheralStatus;

  private handlerAddress: number;
  private threshold: number;
  private currentValue: number;
  private wasAboveThreshold: boolean;
  private pendingFire: boolean;
  private forceFire: boolean;

  constructor(
    id: string,
    name: string,
    handlerAddress: number,
    threshold: number,
    priority: number = 3
  ) {
    this.id = id;
    this.name = name;
    this.handlerAddress = handlerAddress;
    this.threshold = threshold;
    this.priority = priority;
    this.status = PeripheralStatus.DISCONNECTED;
    this.currentValue = 0;
    this.wasAboveThreshold = false;
    this.pendingFire = false;
    this.forceFire = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  connect(): void {
    if (this.status === PeripheralStatus.DISCONNECTED) {
      this.status = PeripheralStatus.IDLE;
    }
  }

  disconnect(): void {
    this.status = PeripheralStatus.DISCONNECTED;
    this.pendingFire = false;
    this.forceFire = false;
    this.wasAboveThreshold = false;
  }

  // ── External Data Feed ────────────────────────────────────────────────

  /**
   * Set the current sensor reading. If this crosses above the threshold
   * (and was previously at or below), an interrupt is queued for the
   * next `tick()`.
   */
  setValue(value: number): void {
    this.currentValue = value;

    const isAbove = value > this.threshold;

    // Fire on rising edge: was at/below threshold, now above
    if (isAbove && !this.wasAboveThreshold) {
      this.pendingFire = true;
    }

    this.wasAboveThreshold = isAbove;
  }

  getValue(): number {
    return this.currentValue;
  }

  getThreshold(): number {
    return this.threshold;
  }

  setThreshold(threshold: number): void {
    this.threshold = threshold;
    // Re-evaluate edge detection with new threshold
    this.wasAboveThreshold = this.currentValue > threshold;
  }

  // ── Trigger (force immediate fire) ────────────────────────────────────

  trigger(): void {
    if (this.status === PeripheralStatus.DISCONNECTED) return;
    this.forceFire = true;
  }

  // ── Tick ──────────────────────────────────────────────────────────────

  tick(): Interrupt | null {
    if (this.status === PeripheralStatus.DISCONNECTED) return null;

    const shouldFire = this.forceFire || this.pendingFire;

    if (shouldFire) {
      this.pendingFire = false;
      this.forceFire = false;
      this.status = PeripheralStatus.ACTIVE;

      const interrupt: Interrupt = {
        source: this.id,
        priority: this.priority,
        handlerAddress: this.handlerAddress,
        timestamp: Date.now(),
      };

      this.status = PeripheralStatus.IDLE;
      return interrupt;
    }

    this.status = PeripheralStatus.IDLE;
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
        type: "sensor",
        threshold: this.threshold,
        currentValue: this.currentValue,
        wasAboveThreshold: this.wasAboveThreshold,
        pendingFire: this.pendingFire,
      },
    };
  }
}
