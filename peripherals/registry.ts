/**
 * @module PeripheralRegistry
 *
 * ★ THE single place to register a peripheral. ★
 *
 * Each entry below describes one peripheral type: its default name, whether
 * it's an input (fires interrupts) or output (reads memory), its config
 * fields, and how to construct it. The WebSocket server, the "Add Peripheral"
 * panel, and the visualizer all read from this registry — so adding a new
 * peripheral is just:
 *
 *   1. Create `peripherals/YourDevice.peripheral.ts` (see README.md)
 *   2. Add ONE entry to {@link PERIPHERAL_REGISTRY} below
 *
 * That's it. The form UI, server factory, ISR wiring, and canvas layout all
 * pick it up automatically.
 */

import type { MemoryService } from "@/services/Memory.service";
import type { Peripheral } from "@/types/peripheral.types";

import ButtonPeripheral from "./Button.peripheral";
import TimerPeripheral from "./Timer.peripheral";
import { SensorPeripheral } from "./Sensor.peripheral";
import { ProximitySensorPeripheral } from "./ProximitySensor.peripheral";
import { ScreenPeripheral } from "./Screen.peripheral";
import { PotentiometerPeripheral } from "./Potentiometer.peripheral";
import { LEDPeripheral } from "./LED.peripheral";
import { SevenSegmentDisplay } from "./SevenSegmentDisplay.peripheral";

// ─── Definition Types ───────────────────────────────────────────────────────

/**
 * One configurable field for a peripheral (e.g. a timer's interval).
 * The Add Peripheral panel renders these automatically, and the parsed
 * value is passed to `create()` under the same `key`.
 */
export interface PeripheralField {
  /** Key used in the form and the WS message (e.g. `"interval"`). */
  key: string;
  /** Placeholder / label shown in the Add Peripheral panel. */
  label: string;
  /**
   * Input widget + parsing rule:
   * - `"number"` — numeric input, parsed base-10
   * - `"hex"`    — text input, parsed base-16 (for memory addresses)
   * - `"text"`   — plain string
   * - `"color"`  — color picker, passed as a hex string like `"#ef4444"`
   * - `"select"` — dropdown; provide `options`
   */
  input: "number" | "hex" | "text" | "color" | "select";
  /** Default value as it appears in the form (string). */
  defaultValue: string;
  /** Choices for `"select"` inputs. */
  options?: string[];
  min?: number;
  max?: number;
}

/** Parsed values handed to `create()` — base props plus one key per field. */
export interface PeripheralConfig {
  id: string;
  name: string;
  handlerAddress: number;
  priority: number;
  [fieldKey: string]: unknown;
}

/** Everything the app needs to know about one peripheral type. */
export interface PeripheralDefinition {
  /** Unique type key, e.g. `"buzzer"`. Used in WS messages and node lookups. */
  type: string;
  /** Default display name for new instances. */
  defaultName: string;
  /**
   * - `"input"`  — fires interrupts at the CPU; gets a handler address and
   *                is drawn above the CPU in the visualizer.
   * - `"output"` — reads memory and renders; never fires interrupts and is
   *                drawn below Memory in the visualizer.
   */
  kind: "input" | "output";
  /** Base ISR address for input peripherals (instances spaced 0x20 apart). */
  handlerBase?: number;
  /** Default interrupt priority (0 = most urgent). */
  defaultPriority?: number;
  /**
   * Memory address of this type's ISR counter. When set, the server
   * auto-loads an ISR at the handler address that increments this byte on
   * every interrupt. Pick an unused address in the first 64 bytes. Omit for
   * output peripherals (they never interrupt).
   */
  dataAddress?: number;
  /** Extra config fields — rendered automatically in the Add panel. */
  fields: PeripheralField[];
  /** Build an instance from the submitted config. */
  create: (config: PeripheralConfig, memory: MemoryService) => Peripheral;
  /** Handle live `updatePeripheral` messages from the UI (optional). */
  applyUpdates?: (
    peripheral: Peripheral,
    updates: Record<string, unknown>,
  ) => void;
}

// ─── The Registry ───────────────────────────────────────────────────────────

export const PERIPHERAL_REGISTRY: PeripheralDefinition[] = [
  {
    type: "button",
    defaultName: "Power Button",
    kind: "input",
    handlerBase: 0x0080,
    defaultPriority: 0,
    dataAddress: 0x003F,
    fields: [],
    create: (c) => new ButtonPeripheral(c.id, c.name, c.handlerAddress, c.priority),
  },
  {
    type: "timer",
    defaultName: "System Timer",
    kind: "input",
    handlerBase: 0x0090,
    defaultPriority: 2,
    dataAddress: 0x003D,
    fields: [
      { key: "interval", label: "Interval (ticks)", input: "number", defaultValue: "10", min: 1 },
    ],
    create: (c) =>
      new TimerPeripheral(c.id, c.name, c.handlerAddress, (c.interval as number) ?? 10, c.priority),
    applyUpdates: (p, u) => {
      const timer = p as TimerPeripheral;
      if (typeof u.interval === "number") timer.setInterval(u.interval);
    },
  },
  {
    type: "sensor",
    defaultName: "Temp Sensor",
    kind: "input",
    handlerBase: 0x00A0,
    defaultPriority: 3,
    dataAddress: 0x003E,
    fields: [
      { key: "threshold", label: "Threshold", input: "number", defaultValue: "75", min: 0 },
    ],
    create: (c) =>
      new SensorPeripheral(c.id, c.name, c.handlerAddress, (c.threshold as number) ?? 75, c.priority),
    applyUpdates: (p, u) => {
      const sensor = p as SensorPeripheral;
      if (typeof u.threshold === "number") sensor.setThreshold(u.threshold);
      if (typeof u.currentValue === "number") sensor.setValue(u.currentValue);
    },
  },
  {
    type: "proximity",
    defaultName: "Prox Sensor",
    kind: "input",
    handlerBase: 0x00B0,
    defaultPriority: 1,
    dataAddress: 0x0039,
    fields: [
      { key: "radius", label: "Radius (px)", input: "number", defaultValue: "100", min: 1 },
    ],
    create: (c, memory) =>
      new ProximitySensorPeripheral(
        c.id, c.name, c.handlerAddress, (c.radius as number) ?? 100, c.priority, memory,
      ),
    applyUpdates: (p, u) => {
      const prox = p as ProximitySensorPeripheral;
      if (typeof u.currentDistance === "number") prox.setDistance(u.currentDistance);
      if (typeof u.radius === "number") prox.setRadius(u.radius);
    },
  },
  {
    type: "potentiometer",
    defaultName: "Potentiometer",
    kind: "input",
    handlerBase: 0x00C0,
    defaultPriority: 2,
    dataAddress: 0x003B,
    fields: [
      { key: "maxResistance", label: "Max resistance", input: "number", defaultValue: "100", min: 1 },
    ],
    create: (c, memory) =>
      new PotentiometerPeripheral(
        c.id,
        c.name,
        c.handlerAddress,
        (c.maxResistance as number) ?? 100,
        c.priority,
        memory,
        (c.registerAddress as number) ?? 0x003A,
      ),
    applyUpdates: (p, u) => {
      const pot = p as PotentiometerPeripheral;
      if (typeof u.maxResistance === "number") pot.setMaxResistance(u.maxResistance);
      if (typeof u.currentResistance === "number") pot.setResistance(u.currentResistance);
    },
  },
  {
    type: "screen",
    defaultName: "Screen 32×8",
    kind: "output",
    fields: [
      { key: "gridWidth", label: "Width", input: "number", defaultValue: "32", min: 4, max: 64 },
      { key: "gridHeight", label: "Height", input: "number", defaultValue: "8", min: 2, max: 16 },
      { key: "sourceAddress", label: "Source addr (hex)", input: "hex", defaultValue: "0038" },
    ],
    create: (c, memory) =>
      new ScreenPeripheral(
        c.id,
        c.name,
        c.handlerAddress,
        (c.gridWidth as number) ?? 32,
        (c.gridHeight as number) ?? 8,
        (c.sourceAddress as number) ?? 0x0038,
        memory,
      ),
    applyUpdates: (p, u) => {
      const screen = p as ScreenPeripheral;
      if (typeof u.sourceAddress === "number") screen.setSourceAddress(u.sourceAddress);
      if (typeof u.tickDivider === "number") screen.setTickDivider(u.tickDivider);
      if (u.clear === true) screen.clearScreen();
    },
  },
  {
    type: "led",
    defaultName: "LED",
    kind: "output",
    fields: [
      { key: "color", label: "Color", input: "color", defaultValue: "#ef4444" },
      { key: "sourceAddress", label: "Source addr (hex)", input: "hex", defaultValue: "003A" },
      { key: "initialLevel", label: "Initial state", input: "select", defaultValue: "LOW", options: ["LOW", "HIGH"] },
    ],
    create: (c, memory) =>
      new LEDPeripheral(
        c.id,
        c.name,
        0,
        (c.color as string) ?? "#ef4444",
        memory,
        (c.sourceAddress as number) ?? 0x003A,
        c.initialLevel === "HIGH" ? "HIGH" : "LOW",
      ),
    applyUpdates: (p, u) => {
      const led = p as LEDPeripheral;
      if (typeof u.sourceAddress === "number") led.setSourceAddress(u.sourceAddress);
    },
  },
  {
    type: "seven-segment-display",
    defaultName: "Seven Segment Display",
    kind: "output",
    fields: [
      { key: "sourceAddress", label: "Source addr (hex)", input: "hex", defaultValue: "0038" },
    ],
    create: (c, memory) =>
      new SevenSegmentDisplay(c.id, c.name, 0, (c.sourceAddress as number) ?? 0x0038, memory),
    applyUpdates: (p, u) => {
      const display = p as SevenSegmentDisplay;
      if (typeof u.sourceAddress === "number") display.setSourceAddress(u.sourceAddress);
      if (u.clear === true) display.clearScreen();
    },
  },
];

// ─── Lookup Helpers ─────────────────────────────────────────────────────────

/** All registered type keys, in display order. */
export const PERIPHERAL_TYPES = PERIPHERAL_REGISTRY.map((d) => d.type);

/** Find a definition by its type key. */
export function getDefinition(type: string): PeripheralDefinition | undefined {
  return PERIPHERAL_REGISTRY.find((d) => d.type === type);
}

/** True if the type is an output peripheral (reads memory, never interrupts). */
export function isOutputType(type: string): boolean {
  return getDefinition(type)?.kind === "output";
}
