"use client";

/**
 * @module AddPeripheralPanel
 *
 * Collapsible side-panel for registering new peripherals and listing
 * existing ones. The type buttons, presets, and config fields are all
 * generated from `peripherals/registry.ts` — register a peripheral there
 * and it shows up here automatically.
 */

import { useState } from "react";
import { useSimulation } from "@/app/_modules/SimulationProvider.module";
import { getPeripheralColor } from "@/app/_utils/peripheralColors";
import {
  PERIPHERAL_REGISTRY,
  getDefinition,
  type PeripheralDefinition,
  type PeripheralField,
} from "@/peripherals/registry";

// ─── Form State ─────────────────────────────────────────────────────────────

/** Form field values kept as strings for controlled inputs. */
interface FormState {
  peripheralType: string;
  name: string;
  handlerAddress: string; // hex input as string, parsed on submit
  priority: string;
  /** Values for the selected type's registry fields, keyed by field key. */
  fields: Record<string, string>;
}

/** Default string values for a definition's config fields. */
function defaultFieldValues(def: PeripheralDefinition): Record<string, string> {
  return Object.fromEntries(def.fields.map((f) => [f.key, f.defaultValue]));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Per-type counter so each new peripheral of the same type gets a unique handler address. */
const typeCounts: Record<string, number> = {};
let idCounter = 0;

/** Generate a unique ID for a new peripheral. */
function nextId(type: string): string {
  idCounter++;
  return `${type}-${idCounter}`;
}

/** Return a handler address that doesn't overlap with previously added peripherals of this type. */
function nextHandlerAddress(def: PeripheralDefinition): string {
  if (def.kind === "output") return "0000"; // outputs never fire interrupts
  const count = typeCounts[def.type] ?? 0;
  typeCounts[def.type] = count + 1;
  const addr = (def.handlerBase ?? 0x0080) + count * 0x20; // 32-byte spacing
  return addr.toString(16).padStart(4, "0");
}

/** Parse a form string into the value sent to the server, per field kind. */
function parseFieldValue(field: PeripheralField, value: string): unknown {
  switch (field.input) {
    case "number": {
      const n = parseInt(value, 10);
      return isNaN(n) ? parseInt(field.defaultValue, 10) : n;
    }
    case "hex": {
      const n = parseInt(value, 16);
      return isNaN(n) ? parseInt(field.defaultValue, 16) : n;
    }
    default:
      return value || field.defaultValue;
  }
}

const FIRST_DEF = PERIPHERAL_REGISTRY[0];

const DEFAULT_FORM: FormState = {
  peripheralType: FIRST_DEF.type,
  name: "",
  handlerAddress: (FIRST_DEF.handlerBase ?? 0x0080).toString(16).padStart(4, "0"),
  priority: String(FIRST_DEF.defaultPriority ?? 0),
  fields: defaultFieldValues(FIRST_DEF),
};

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Collapsible panel for adding peripherals to the simulation.
 *
 * Renders a form with name, handler address (input peripherals only),
 * priority, and whatever config fields the selected type declares in the
 * registry. Also lists currently registered peripherals with a remove button.
 */
export function AddPeripheralPanel() {
  const { addPeripheral, removePeripheral, peripherals, connected } =
    useSimulation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);

  const selectedDef = getDefinition(form.peripheralType) ?? FIRST_DEF;

  function applyPreset(def: PeripheralDefinition) {
    setForm((prev) => ({
      ...prev,
      peripheralType: def.type,
      handlerAddress: nextHandlerAddress(def),
      priority: String(def.defaultPriority ?? 0),
      fields: defaultFieldValues(def),
    }));
  }

  function setFieldValue(key: string, value: string) {
    setForm((prev) => ({
      ...prev,
      fields: { ...prev.fields, [key]: value },
    }));
  }

  function handleSubmit() {
    const isOutput = selectedDef.kind === "output";
    const handlerAddress = isOutput ? 0 : parseInt(form.handlerAddress, 16);
    if (isNaN(handlerAddress)) return;

    addPeripheral({
      peripheralType: selectedDef.type,
      id: nextId(selectedDef.type),
      name: form.name || selectedDef.defaultName,
      handlerAddress,
      priority: parseInt(form.priority) || 0,
      ...Object.fromEntries(
        selectedDef.fields.map((f) => [
          f.key,
          parseFieldValue(f, form.fields[f.key] ?? f.defaultValue),
        ]),
      ),
    });

    // Reset name so the next add gets a fresh one
    setForm((prev) => ({ ...prev, name: "" }));
  }

  const inputClass =
    "w-full px-2 py-1 rounded-md border border-zinc-200 text-xs bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-indigo-300";

  /** Render one registry-declared config field with the right widget. */
  function renderField(field: PeripheralField) {
    const value = form.fields[field.key] ?? field.defaultValue;

    switch (field.input) {
      case "color":
        return (
          <div
            key={field.key}
            className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5"
          >
            <label className="text-[11px] text-zinc-600">{field.label}</label>
            <input
              type="color"
              value={value}
              onChange={(e) => setFieldValue(field.key, e.target.value)}
              className="h-6 w-10 cursor-pointer rounded border border-zinc-200 bg-white"
            />
            <span className="text-[10px] font-mono text-zinc-500 uppercase">
              {value}
            </span>
          </div>
        );
      case "select":
        return (
          <div
            key={field.key}
            className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5"
          >
            <label className="text-[11px] text-zinc-600">{field.label}</label>
            <select
              value={value}
              onChange={(e) => setFieldValue(field.key, e.target.value)}
              className="ml-auto px-2 py-1 rounded border border-zinc-200 bg-white text-[11px] text-zinc-700"
            >
              {(field.options ?? []).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        );
      case "number":
        return (
          <input
            key={field.key}
            className={inputClass}
            placeholder={field.label}
            type="number"
            min={field.min}
            max={field.max}
            value={value}
            onChange={(e) => setFieldValue(field.key, e.target.value)}
          />
        );
      default: // "hex" and "text" are both free-form text inputs
        return (
          <input
            key={field.key}
            className={inputClass}
            placeholder={field.label}
            value={value}
            onChange={(e) => setFieldValue(field.key, e.target.value)}
          />
        );
    }
  }

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
          {/* ── Type selector (one button per registry entry) ─────── */}
          <div className="flex gap-1 flex-wrap">
            {PERIPHERAL_REGISTRY.map((def) => (
              <button
                key={def.type}
                onClick={() => applyPreset(def)}
                className={`flex-1 min-w-15 px-2 py-1 rounded-md text-[10px] font-medium capitalize transition-colors ${form.peripheralType === def.type
                  ? "bg-indigo-100 text-indigo-700"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                  }`}
              >
                {def.type}
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
              {selectedDef.kind === "input" && (
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

            {/* Type-specific fields, straight from the registry */}
            {selectedDef.fields.map(renderField)}
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
