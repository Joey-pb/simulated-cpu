"use client";

import { useSimulation } from "@/app/_modules/SimulationProvider.module";
import { getPeripheralColor } from "@/app/_utils/peripheralColors";
/**
 * @module AddPeripheralPanel
 *
 * Collapsible side-panel for registering new peripherals and listing
 * existing ones. Provides type presets, auto-incrementing handler
 * addresses, and a remove button per peripheral.
 */

import { useState } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Supported peripheral type identifiers. */
type PeripheralType = "button" | "timer" | "sensor" | "proximity" | "screen" | "potentiometer" | "led";

/** Form field values kept as strings for controlled inputs. */
interface FormState {
  peripheralType: PeripheralType;
  name: string;
  handlerAddress: string; // hex input as string, parsed on submit
  priority: string;
  interval: string;       // timer-only
  threshold: string;      // sensor-only
  radius: string;         // proximity-only
  gridWidth: string;      // screen-only
  gridHeight: string;     // screen-only
  sourceAddress: string;  // screen-only
  maxResistance: string;  // potentiometer-only
  ledColor: string;       // led-only (create-time only)
  ledSourceAddress: string; // led-only
  ledInitialLevel: "LOW" | "HIGH"; // led-only
}

const DEFAULT_FORM: FormState = {
  peripheralType: "button",
  name: "",
  handlerAddress: "0080",
  priority: "0",
  interval: "10",
  threshold: "75",
  radius: "100",
  gridWidth: "32",
  gridHeight: "8",
  sourceAddress: "0038",
  maxResistance: "100",
  ledColor: "#ef4444",
  ledSourceAddress: "003A",
  ledInitialLevel: "LOW",
};

// ─── Presets ────────────────────────────────────────────────────────────────

/** Base handler addresses per type (each ISR needs 20 bytes of space). */
const HANDLER_BASE: Record<PeripheralType, number> = {
  button: 0x0080,
  timer: 0x0090,
  sensor: 0x00A0,
  proximity: 0x00B0,
  potentiometer: 0x00C0,
  screen: 0x0000, // screen doesn't fire interrupts — no handler needed
  led: 0x0000, // LED is output-only and does not fire interrupts
};

/** Default field values that pre-populate for each type. */
const PRESETS: Record<PeripheralType, Partial<FormState>> = {
  button: { name: "Power Button", handlerAddress: "0080", priority: "0" },
  timer: { name: "System Timer", handlerAddress: "0090", priority: "2", interval: "10" },
  sensor: { name: "Temp Sensor", handlerAddress: "00A0", priority: "3", threshold: "75" },
  proximity: { name: "Prox Sensor", handlerAddress: "00B0", priority: "1", radius: "100" },
  potentiometer: { name: "Potentiometer", handlerAddress: "00C0", priority: "2", maxResistance: "100" },
  screen: { name: "Screen 32×8", handlerAddress: "0000", priority: "0", gridWidth: "32", gridHeight: "8", sourceAddress: "0038" },
  led: {
    name: "LED",
    handlerAddress: "0000",
    priority: "0",
    ledColor: "#ef4444",
    ledSourceAddress: "003A",
    ledInitialLevel: "LOW",
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Per-type counter so each new peripheral of the same type gets a unique handler address. */
const typeCounts: Record<PeripheralType, number> = {
  button: 0,
  timer: 0,
  sensor: 0,
  proximity: 0,
  screen: 0,
  potentiometer: 0,
  led: 0,
};
let idCounter = 0;
/** Generate a unique ID for a new peripheral. */
function nextId(type: PeripheralType): string {
  idCounter++;
  return `${type}-${idCounter}`;
}

/** Return a handler address that doesn't overlap with previously added peripherals of this type. */
function nextHandlerAddress(type: PeripheralType): string {
  const addr = HANDLER_BASE[type] + typeCounts[type] * 0x20; // 32-byte spacing
  typeCounts[type]++;
  return addr.toString(16).padStart(4, "0");
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Collapsible panel for adding peripherals to the simulation.
 *
 * Provides a form with fields for type, name, handler address, priority,
 * and type-specific options (interval for Timer, threshold for Sensor).
 * Also lists currently registered peripherals with a remove button.
 */
export function AddPeripheralPanel() {
  const { addPeripheral, removePeripheral, peripherals, connected } =
    useSimulation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);

  function applyPreset(type: PeripheralType) {
    setForm((prev) => ({
      ...prev,
      ...PRESETS[type],
      peripheralType: type,
      handlerAddress: nextHandlerAddress(type),
    }));
  }

  function handleSubmit() {
    const handlerAddress = parseInt(form.handlerAddress, 16);
    if (isNaN(handlerAddress) && form.peripheralType !== "screen" && form.peripheralType !== "led") return;

    addPeripheral({
      peripheralType: form.peripheralType,
      id: nextId(form.peripheralType),
      name: form.name || PRESETS[form.peripheralType].name || form.peripheralType,
      handlerAddress: form.peripheralType === "screen" || form.peripheralType === "led" ? 0 : handlerAddress,
      priority: parseInt(form.priority) || 0,
      ...(form.peripheralType === "timer" && {
        interval: parseInt(form.interval) || 10,
      }),
      ...(form.peripheralType === "sensor" && {
        threshold: parseInt(form.threshold) || 75,
      }),
      ...(form.peripheralType === "proximity" && {
        radius: parseInt(form.radius) || 100,
      }),
      ...(form.peripheralType === "screen" && {
        gridWidth: parseInt(form.gridWidth) || 32,
        gridHeight: parseInt(form.gridHeight) || 8,
        sourceAddress: parseInt(form.sourceAddress, 16) || 0x0038,
      }),
      ...(form.peripheralType === "potentiometer" && {
        maxResistance: parseInt(form.maxResistance) || 100,
      }),
      ...(form.peripheralType === "led" && {
        color: form.ledColor || "#ef4444",
        sourceAddress: parseInt(form.ledSourceAddress, 16) || 0x003A,
        initialLevel: form.ledInitialLevel,
      }),
    });

    // Reset name so the next add gets a fresh one
    setForm((prev) => ({ ...prev, name: "" }));
  }

  const inputClass =
    "w-full px-2 py-1 rounded-md border border-zinc-200 text-xs bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-indigo-300";

  return (
    <div className="bg-white border border-zinc-200 rounded-xl shadow-lg overflow-hidden min-w-64">
      {/* Toggle header */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 transition-colors"
      >
        <span>Peripherals ({peripherals.length})</span>
        <span className="text-zinc-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          {/* ── Type selector ─────────────────────────────────────── */}
          <div className="flex gap-1 flex-wrap">
            {(["button", "timer", "sensor", "proximity", "potentiometer", "screen", "led"] as PeripheralType[]).map((t) => (
              <button
                key={t}
                onClick={() => applyPreset(t)}
                className={`flex-1 min-w-15 px-2 py-1 rounded-md text-[10px] font-medium capitalize transition-colors ${form.peripheralType === t
                  ? "bg-indigo-100 text-indigo-700"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                  }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* ── Form fields ───────────────────────────────────────── */}
          <div className="space-y-1.5">
            <input
              className={inputClass}
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <div className="flex gap-1.5">
              {form.peripheralType !== "screen" && form.peripheralType !== "led" && (
                <input
                  className={inputClass}
                  placeholder="Handler (hex)"
                  value={form.handlerAddress}
                  onChange={(e) =>
                    setForm({ ...form, handlerAddress: e.target.value })
                  }
                />
              )}
              <input
                className={inputClass}
                placeholder="Priority"
                type="number"
                min={0}
                value={form.priority}
                onChange={(e) =>
                  setForm({ ...form, priority: e.target.value })
                }
              />
            </div>

            {/* Timer-specific */}
            {form.peripheralType === "timer" && (
              <input
                className={inputClass}
                placeholder="Interval (ticks)"
                type="number"
                min={1}
                value={form.interval}
                onChange={(e) =>
                  setForm({ ...form, interval: e.target.value })
                }
              />
            )}

            {/* Sensor-specific */}
            {form.peripheralType === "sensor" && (
              <input
                className={inputClass}
                placeholder="Threshold"
                type="number"
                min={0}
                value={form.threshold}
                onChange={(e) =>
                  setForm({ ...form, threshold: e.target.value })
                }
              />
            )}

            {/* Proximity-specific */}
            {form.peripheralType === "proximity" && (
              <input
                className={inputClass}
                placeholder="Radius (px)"
                type="number"
                min={1}
                value={form.radius}
                onChange={(e) =>
                  setForm({ ...form, radius: e.target.value })
                }
              />
            )}

            {/* Potentiometer-specific */}
            {form.peripheralType === "potentiometer" && (
              <input
                className={inputClass}
                placeholder="Max resistance"
                type="number"
                min={1}
                value={form.maxResistance}
                onChange={(e) =>
                  setForm({ ...form, maxResistance: e.target.value })
                }
              />
            )}

            {/* Screen-specific */}
            {form.peripheralType === "screen" && (
              <>
                <div className="flex gap-1.5">
                  <input
                    className={inputClass}
                    placeholder="Width"
                    type="number"
                    min={4}
                    max={64}
                    value={form.gridWidth}
                    onChange={(e) =>
                      setForm({ ...form, gridWidth: e.target.value })
                    }
                  />
                  <input
                    className={inputClass}
                    placeholder="Height"
                    type="number"
                    min={2}
                    max={16}
                    value={form.gridHeight}
                    onChange={(e) =>
                      setForm({ ...form, gridHeight: e.target.value })
                    }
                  />
                </div>
                <input
                  className={inputClass}
                  placeholder="Source addr (hex)"
                  value={form.sourceAddress}
                  onChange={(e) =>
                    setForm({ ...form, sourceAddress: e.target.value })
                  }
                />
              </>
            )}

            {/* LED-specific */}
            {form.peripheralType === "led" && (
              <>
                <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5">
                  <label className="text-[11px] text-zinc-600">Color</label>
                  <input
                    type="color"
                    value={form.ledColor}
                    onChange={(e) => setForm({ ...form, ledColor: e.target.value })}
                    className="h-6 w-10 cursor-pointer rounded border border-zinc-200 bg-white"
                  />
                  <span className="text-[10px] font-mono text-zinc-500 uppercase">{form.ledColor}</span>
                </div>
                <input
                  className={inputClass}
                  placeholder="Source addr (hex)"
                  value={form.ledSourceAddress}
                  onChange={(e) =>
                    setForm({ ...form, ledSourceAddress: e.target.value })
                  }
                />
                <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5">
                  <label className="text-[11px] text-zinc-600">Initial state</label>
                  <select
                    value={form.ledInitialLevel}
                    onChange={(e) =>
                      setForm({ ...form, ledInitialLevel: e.target.value as "LOW" | "HIGH" })
                    }
                    className="ml-auto px-2 py-1 rounded border border-zinc-200 bg-white text-[11px] text-zinc-700"
                  >
                    <option value="LOW">LOW</option>
                    <option value="HIGH">HIGH</option>
                  </select>
                </div>
              </>
            )}
          </div>

          {/* ── Add button ────────────────────────────────────────── */}
          <button
            onClick={handleSubmit}
            disabled={!connected}
            className="w-full px-2 py-1.5 rounded-lg text-xs font-medium bg-indigo-500 text-white
              hover:bg-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            + Add Peripheral
          </button>

          {/* ── Registered peripherals list ────────────────────────── */}
          {peripherals.length > 0 && (
            <div className="border-t border-zinc-100 pt-2 space-y-1">
              <div className="text-[10px] text-zinc-400 font-semibold uppercase tracking-wide">
                Registered
              </div>
              {peripherals.map((p, i) => {
                const c = getPeripheralColor(i);
                return (
                  <div
                    key={p.id}
                    className="flex items-center justify-between text-[11px] text-zinc-600"
                  >
                    <span className="flex items-center gap-1.5 truncate mr-2">
                      <span
                        className={`inline-block w-2.5 h-2.5 rounded-sm shrink-0 ${c.bg}`}
                      />
                      {p.name}
                    </span>
                    <button
                      onClick={() => removePeripheral(p.id)}
                      className="text-red-400 hover:text-red-600 text-[10px] font-bold shrink-0"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
