/**
 * @module peripheral.types
 *
 * Type definitions for peripheral devices and interrupt signalling.
 * Every peripheral implements the {@link Peripheral} interface and
 * communicates with the CPU via {@link Interrupt} objects.
 */

// ─── Peripheral Status ──────────────────────────────────────────────────────

/**
 * Lifecycle state of a peripheral device.
 *
 * - **DISCONNECTED** — Not wired to the CPU bus.
 * - **CONNECTED** — Wired but not yet ticked.
 * - **ACTIVE** — Currently generating an interrupt.
 * - **IDLE** — Connected but not firing.
 */
export enum PeripheralStatus {
  DISCONNECTED = "DISCONNECTED",
  CONNECTED = "CONNECTED",
  ACTIVE = "ACTIVE",
  IDLE = "IDLE",
}

// ─── Interrupt ──────────────────────────────────────────────────────────────

/**
 * An interrupt request (IRQ) raised by a peripheral.
 * The {@link InterruptController} queues these by priority, and the CPU
 * dispatches them to available cores.
 */
export interface Interrupt {
  /** ID of the peripheral that raised the interrupt. */
  source: string;
  /** Priority level — lower number = higher urgency. */
  priority: number;
  /** Address in memory of the Interrupt Service Routine to execute. */
  handlerAddress: number;
  /** Unix timestamp (ms) when the interrupt was created. */
  timestamp: number;
}

// ─── Peripheral Interface ───────────────────────────────────────────────────

/**
 * Contract that all peripheral devices must implement.
 *
 * The {@link PeripheralManager} calls `tick()` once per CPU cycle on every
 * connected peripheral. If the peripheral needs to fire, it returns an
 * {@link Interrupt}; otherwise it returns `null`.
 */
export interface Peripheral<Meta = Record<string, unknown>> {
  /** Unique identifier (e.g. `"timer-1"`). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Interrupt priority (lower = more urgent). */
  priority: number;
  /** Current lifecycle status. */
  status: PeripheralStatus;

  /** Wire the peripheral to the CPU bus. */
  connect(): void;
  /** Disconnect the peripheral from the CPU bus. */
  disconnect(): void;

  /** Called each tick; returns an interrupt if the peripheral wants to fire, else `null`. */
  tick(): Interrupt | null;

  /** Trigger the peripheral manually (e.g. button press). */
  trigger(): void;

  /** Serialise state for persistence / UI display. */
  toJSON(): PeripheralSnapshot<Meta>;
}

// ─── Serialisable Snapshot ──────────────────────────────────────────────────

/**
 * JSON-safe representation of a peripheral's state.
 * Used for persistence and for broadcasting to the frontend.
 */
export interface PeripheralSnapshot<Meta = Record<string, unknown>> {
  /** Peripheral ID. */
  id: string;
  /** Display name. */
  name: string;
  /** Interrupt priority. */
  priority: number;
  /** Current status. */
  status: PeripheralStatus;
  /** ISR entry point address. */
  handlerAddress: number;
  /** Peripheral-specific data (e.g. timer interval, sensor threshold). */
  meta: Meta;
}
