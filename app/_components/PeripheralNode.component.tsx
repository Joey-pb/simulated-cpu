"use client";

/**
 * @module PeripheralNode
 *
 * React Flow custom node for a peripheral device. Renders status, handler
 * address, type-specific inline controls (sensor sliders, timer interval),
 * and a trigger button for button-type peripherals.
 */

import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useSimulation } from "@/app/_modules/SimulationProvider.module";
import { getPeripheralColor } from "@/app/_utils/peripheralColors";
import type { PeripheralSnapshot } from "@/types/peripheral.types";
import { CMD, STATUS } from "@/peripherals/HardDrive.peripheral";

// ─── Debounced Update Hook ──────────────────────────────────────────────────

/** Debounce window (ms) for peripheral config updates sent to the server. */
const DEBOUNCE_MS = 150;

/**
 * Returns a stable callback that debounces calls to `updatePeripheral`.
 * During the debounce window, updated values are batched so only the
 * latest value for each key is sent.
 */
function useDebouncedUpdate(
  updatePeripheral: (id: string, updates: Record<string, unknown>) => void,
) {
  const pending = useRef<Record<string, Record<string, unknown>>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  return useCallback(
    (id: string, updates: Record<string, unknown>) => {
      // Merge into pending updates for this peripheral
      pending.current[id] = { ...pending.current[id], ...updates };

      // Reset the timer for this peripheral
      if (timers.current[id]) clearTimeout(timers.current[id]);
      timers.current[id] = setTimeout(() => {
        updatePeripheral(id, pending.current[id]);
        delete pending.current[id];
        delete timers.current[id];
      }, DEBOUNCE_MS);
    },
    [updatePeripheral],
  );
}

// ─── Status Colours ─────────────────────────────────────────────────────────

/** Tailwind dot class per peripheral status. */
const STATUS_COLOURS: Record<string, { dot: string }> = {
  DISCONNECTED: { dot: "bg-zinc-400" },
  CONNECTED: { dot: "bg-blue-400" },
  IDLE: { dot: "bg-amber-400" },
  ACTIVE: { dot: "bg-green-500" },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Format a number as a zero-padded 4-digit hex string with "0x" prefix. */
function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, "0")}`;
}

// ─── Status Badge ───────────────────────────────────────────────────────────

/** Coloured dot + label showing a peripheral's connection status. */
function StatusBadge({ status }: { status: string }) {
  const colours = STATUS_COLOURS[status] ?? STATUS_COLOURS.DISCONNECTED;
  const pulse = status === "ACTIVE" ? "animate-pulse" : "";

  return (
    <span className="flex items-center gap-1 text-[10px] text-zinc-600">
      <span
        className={`inline-block w-2 h-2 rounded-full ${colours.dot} ${pulse}`}
      />
      {status}
    </span>
  );
}

// ─── Pointer-event blocker ──────────────────────────────────────────────────

/** Stop pointer events from propagating to React Flow so sliders/inputs work. */
function stopPropagation(e: ReactPointerEvent) {
  e.stopPropagation();
}

// ─── Inline Config Controls ─────────────────────────────────────────────────

/** Detect peripheral type from the meta keys present. */
function detectType(
  meta: Record<string, unknown>,
):
  | "sensor"
  | "timer"
  | "button"
  | "proximity"
  | "screen"
  | "hard-drive"
  | "unknown" {
  if ("threshold" in meta && "currentValue" in meta) return "sensor";
  if ("interval" in meta && "counter" in meta) return "timer";
  if ("armed" in meta) return "button";
  if ("radius" in meta && "currentDistance" in meta) return "proximity";
  if ("pixels" in meta && "width" in meta) return "screen";
  if ("diskStorage" in meta && "cmdAddress" in meta) return "hard-drive";

  return "unknown";
}

/** Shared style for the small inline number input. */
const INPUT_CLASS =
  "w-14 px-1 py-0.5 rounded border border-zinc-200 bg-zinc-50 text-[10px] " +
  "font-mono text-zinc-700 text-right focus:outline-none focus:border-blue-400 " +
  "focus:ring-1 focus:ring-blue-200 transition-colors nopan";

/** Shared style for a range slider. */
const SLIDER_CLASS =
  "w-full h-1 rounded-full appearance-none bg-zinc-200 accent-blue-500 cursor-pointer nopan";

/** Props for {@link ConfigRow}. */
interface ConfigRowProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  color?: string;
}

/** A single row: label, slider, and numeric input. */
function ConfigRow({
  label,
  value,
  min = 0,
  max = 255,
  step = 1,
  onChange,
  color,
}: ConfigRowProps) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-medium ${color ?? "text-zinc-500"}`}>
          {label}
        </span>
        <input
          type="number"
          className={INPUT_CLASS}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!isNaN(v)) onChange(v);
          }}
        />
      </div>
      <input
        type="range"
        className={SLIDER_CLASS}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

// ─── Sensor Controls ────────────────────────────────────────────────────────

/** Inline controls for a sensor peripheral (value + threshold sliders). */
function SensorControls({
  peripheralId,
  meta,
  updatePeripheral,
}: {
  peripheralId: string;
  meta: Record<string, unknown>;
  updatePeripheral: (id: string, updates: Record<string, unknown>) => void;
}) {
  const currentValue = (meta.currentValue as number) ?? 0;
  const threshold = (meta.threshold as number) ?? 75;

  const onValueChange = useCallback(
    (v: number) => updatePeripheral(peripheralId, { currentValue: v }),
    [peripheralId, updatePeripheral],
  );

  const onThresholdChange = useCallback(
    (v: number) => updatePeripheral(peripheralId, { threshold: v }),
    [peripheralId, updatePeripheral],
  );

  return (
    <div className="mt-1.5 pt-1.5 border-t border-zinc-100 space-y-1.5">
      <ConfigRow
        label="Value"
        value={currentValue}
        min={0}
        max={255}
        onChange={onValueChange}
        color="text-amber-600"
      />
      <ConfigRow
        label="Threshold"
        value={threshold}
        min={0}
        max={255}
        onChange={onThresholdChange}
        color="text-blue-600"
      />
      {/* Visual threshold bar */}
      <div className="relative h-1.5 rounded-full bg-zinc-100 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-amber-300 transition-all duration-150"
          style={{ width: `${(currentValue / 255) * 100}%` }}
        />
        <div
          className="absolute inset-y-0 w-0.5 bg-blue-500"
          style={{ left: `${(threshold / 255) * 100}%` }}
          title={`Threshold: ${threshold}`}
        />
      </div>
    </div>
  );
}

// ─── Timer Controls ─────────────────────────────────────────────────────────

/** Inline controls for a timer peripheral (interval slider + counter bar). */
function TimerControls({
  peripheralId,
  meta,
  updatePeripheral,
}: {
  peripheralId: string;
  meta: Record<string, unknown>;
  updatePeripheral: (id: string, updates: Record<string, unknown>) => void;
}) {
  const interval = (meta.interval as number) ?? 10;
  const counter = (meta.counter as number) ?? 0;

  const onIntervalChange = useCallback(
    (v: number) => updatePeripheral(peripheralId, { interval: Math.max(1, v) }),
    [peripheralId, updatePeripheral],
  );

  return (
    <div className="mt-1.5 pt-1.5 border-t border-zinc-100 space-y-1.5">
      <ConfigRow
        label="Interval"
        value={interval}
        min={1}
        max={100}
        onChange={onIntervalChange}
        color="text-emerald-600"
      />
      {/* Counter progress bar */}
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] text-zinc-400">Counter</span>
        <div className="flex-1 h-1.5 rounded-full bg-zinc-100 overflow-hidden">
          <div
            className="h-full bg-emerald-300 transition-all duration-150"
            style={{
              width: `${interval > 0 ? (counter / interval) * 100 : 0}%`,
            }}
          />
        </div>
        <span className="text-[9px] font-mono text-zinc-500 tabular-nums">
          {counter}/{interval}
        </span>
      </div>
    </div>
  );
}

// ─── Hard Drive Controls ────────────────────────────────────────────────────

const CMD_LABELS: Record<CMD, string> = {
  [CMD.NOP]: "NOP",
  [CMD.READ]: "READ",
  [CMD.WRITE]: "WRITE",
};

const STATUS_LABELS: Record<STATUS, string> = {
  [STATUS.IDLE]: "IDLE",
  [STATUS.BUSY]: "BUSY",
  [STATUS.DONE]: "DONE",
  [STATUS.ERROR]: "ERROR",
};

const STATUS_COLORS: Record<STATUS, string> = {
  [STATUS.IDLE]: "text-zinc-400",
  [STATUS.BUSY]: "text-amber-500",
  [STATUS.DONE]: "text-green-500",
  [STATUS.ERROR]: "text-red-500",
};

export function HardDriveControls({
  peripheralId,
  meta,
  updatePeripheralAction,
}: {
  peripheralId: string;
  meta: Record<string, unknown>;
  updatePeripheralAction: (
    id: string,
    updates: Record<string, unknown>,
  ) => void;
}) {
  const [selectedTrack, setSelectedTrack] = useState(0);
  const [editingCell, setEditingCell] = useState<{
    sector: number;
    offset: number;
  } | null>(null);
  const [editValue, setEditValue] = useState("");

  const diskStorage = (meta.diskStorage as number[]) ?? [];
  const driveStatus = (meta.driveStatus as number) ?? 0;
  const currentCmd = (meta.currentCmd as number) ?? 0;
  const currentTrack = (meta.currentTrack as number) ?? 0;
  const currentSector = (meta.currentSector as number) ?? 0;
  const currentOffset = (meta.currentOffset as number) ?? 0;
  const currentData = (meta.currentData as number) ?? 0;
  const trackCount = (meta.trackCount as number) ?? 16;
  const sectorsPerTrack = (meta.sectorsPerTrack as number) ?? 16;
  const bytesPerSector = (meta.bytesPerSector as number) ?? 16;
  const cmdAddress = (meta.cmdAddress as number) ?? 0x3f0;
  const trackAddress = (meta.trackAddress as number) ?? 0x3f1;
  const sectorAddress = (meta.sectorAddress as number) ?? 0x3f2;
  const offsetAddress = (meta.offsetAddress as number) ?? 0x3f3;
  const dataAddress = (meta.dataAddress as number) ?? 0x3f4;
  const statusAddress = (meta.statusAddress as number) ?? 0x3f5;

  function hex2(n: number): string {
    return n.toString(16).padStart(2, "0").toUpperCase();
  }

  function hexAddr(n: number): string {
    return `0x${n.toString(16).toUpperCase()}`;
  }

  // Flat index into diskStorage: track, then sector, then offset —
  // mirrors getDiskIndex() in HardDrive.peripheral.ts.
  function cellValue(track: number, sector: number, offset: number): number {
    const index =
      track * sectorsPerTrack * bytesPerSector +
      sector * bytesPerSector +
      offset;
    return diskStorage[index] ?? 0;
  }

  function startEdit(sector: number, offset: number): void {
    setEditingCell({ sector, offset });
    setEditValue(hex2(cellValue(selectedTrack, sector, offset)));
  }

  function commitEdit(): void {
    if (!editingCell) return;
    const parsed = parseInt(editValue, 16);
    if (!isNaN(parsed)) {
      updatePeripheralAction(peripheralId, {
        track: selectedTrack,
        sector: editingCell.sector,
        offset: editingCell.offset,
        value: Math.min(255, Math.max(0, parsed)),
      });
    }
    setEditingCell(null);
  }

  return (
    <div className="mt-1.5 pt-1.5 border-t border-zinc-100 space-y-1.5">
      {/* Register status — two-column label/value grid for all six control registers */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono">
        <span className="text-zinc-400">CMD</span>
        <span className="text-zinc-600">
          {hex2(currentCmd)} {CMD_LABELS[currentCmd as CMD] ?? "?"}
        </span>

        <span className="text-zinc-400">TRACK</span>
        <span className="text-zinc-600">{currentTrack}</span>

        <span className="text-zinc-400">SECTOR</span>
        <span className="text-zinc-600">{currentSector}</span>

        <span className="text-zinc-400">OFFSET</span>
        <span className="text-zinc-600">{currentOffset}</span>

        <span className="text-zinc-400">DATA</span>
        {/* currentData = memory.read(DATA): what the CPU wrote before a WRITE,
            or what the drive placed there after a READ */}
        <span className="text-zinc-600">{hex2(currentData)}</span>

        <span className="text-zinc-400">STATUS</span>
        <span
          className={`font-semibold ${STATUS_COLORS[driveStatus as STATUS] ?? "text-zinc-400"}`}
        >
          {STATUS_LABELS[driveStatus as STATUS] ?? "?"}
        </span>
      </div>

      {/* Address reference */}
      <div className="text-[9px] text-zinc-400 font-mono leading-relaxed">
        CMD {hexAddr(cmdAddress)} · TRK {hexAddr(trackAddress)} · SECT{" "}
        {hexAddr(sectorAddress)} · OFF {hexAddr(offsetAddress)} · DATA{" "}
        {hexAddr(dataAddress)} · STAT {hexAddr(statusAddress)}
      </div>

      {/* Track selector */}
      <div className="space-y-0.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-zinc-600">Track</span>
          <span className="text-[10px] font-mono text-zinc-600">
            {selectedTrack} / {trackCount - 1}
          </span>
        </div>
        <input
          type="range"
          className={SLIDER_CLASS}
          value={selectedTrack}
          min={0}
          max={Math.max(0, trackCount - 1)}
          step={1}
          onChange={(e) => setSelectedTrack(Number(e.target.value))}
        />
      </div>

      {/* Disk grid — rows = sectors, columns = byte offsets, for whichever
          track is currently selected by the slider above.
          The outer Array.from iterates sectors, the inner iterates offsets.
          .flat() collapses the array-of-arrays into a single list of cells. */}
      <div className="overflow-x-auto">
        <div
          className="grid gap-px bg-zinc-100 border border-zinc-200 rounded text-[8px] font-mono"
          style={{
            gridTemplateColumns: `repeat(${bytesPerSector}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: sectorsPerTrack }, (_, s) =>
            Array.from({ length: bytesPerSector }, (_, o) => {
              const value = cellValue(selectedTrack, s, o);
              const isSet = value !== 0;

              return (
                <div
                  key={`${s}-${o}`}
                  className={`flex items-center justify-center h-5 px-1 py-0.5 cursor-pointer transition-colors ${
                    selectedTrack === currentTrack &&
                    s === currentSector &&
                    o === currentOffset &&
                    driveStatus !== 0
                      ? "bg-amber-200 text-amber-800"
                      : `bg-white hover:bg-indigo-50 ${isSet ? "text-green-600" : "text-zinc-500"}`
                  }`}
                  title={`T${selectedTrack}:S${s}:O${o} = 0x${hex2(value)}`}
                  onClick={() => startEdit(s, o)}
                >
                  {editingCell?.sector === s && editingCell?.offset === o ? (
                    // Inline hex editor — shown when this cell is being edited
                    <input
                      autoFocus
                      className="w-full h-full text-center bg-indigo-100 text-indigo-800 outline-none text-[8px] font-mono"
                      value={editValue}
                      maxLength={2}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit();
                        if (e.key === "Escape") setEditingCell(null);
                      }}
                    />
                  ) : (
                    // Normal display — two uppercase hex digits
                    hex2(value)
                  )}
                </div>
              );
            }),
          ).flat()}
        </div>
      </div>

      <div className="text-[8px] text-zinc-400">
        {trackCount} tracks × {sectorsPerTrack} sectors × {bytesPerSector} bytes
        · click any cell to edit
      </div>
    </div>
  );
}

// ─── Peripheral Node ────────────────────────────────────────────────────────

/** React Flow custom node rendering a single peripheral device card. */
export function PeripheralNode({ data }: NodeProps) {
  const {
    triggerPeripheral,
    removePeripheral,
    updatePeripheral,
    interruptSources,
    peripherals,
  } = useSimulation();
  const debouncedUpdate = useDebouncedUpdate(updatePeripheral);
  const peripheral = data.peripheral as PeripheralSnapshot | undefined;

  if (!peripheral) {
    return (
      <div className="bg-white border border-zinc-200 rounded-lg px-3 py-2 text-xs text-zinc-400">
        No peripheral data
      </div>
    );
  }

  // Deterministic color by peripheral index in the current peripherals list.
  // Use a hash of the ID as a fallback so peripherals never share the same
  // default colour (index 0) when the lookup misses.
  const pIndex = peripherals.findIndex((p) => p.id === peripheral.id);
  const pColor = getPeripheralColor(
    pIndex !== -1
      ? pIndex
      : [...peripheral.id].reduce((h, c) => h + c.charCodeAt(0), 0),
  );

  const pType = detectType(peripheral.meta);
  const isInteractive = pType === "button";
  const isFiring = interruptSources.includes(peripheral.id);

  return (
    <div
      className={`bg-white border border-zinc-200 ${pColor.borderL} border-l-4 rounded-lg
        shadow-sm px-3 py-2 min-w-64 max-w-96 text-xs text-zinc-700 transition-all duration-200`}
    >
      {/* Title + color swatch + Delete */}
      <div className="flex items-center justify-between mb-1 gap-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-sm shrink-0 ${pColor.bg}`}
          />
          <div className="font-semibold text-[11px] truncate">
            {peripheral.name}
          </div>
        </div>
        <button
          onClick={() => removePeripheral(peripheral.id)}
          className="text-red-400 hover:text-red-600 text-[10px] font-bold shrink-0
            leading-none px-0.5 rounded hover:bg-red-50 transition-colors"
          title="Remove peripheral"
        >
          ✕
        </button>
      </div>

      {/* Status + Priority row */}
      <div className="flex items-center justify-between mb-1">
        <StatusBadge status={peripheral.status} />
        <span className="text-[10px] text-zinc-400">
          pri: {peripheral.priority}
        </span>
      </div>

      {/* Handler address */}
      <div className="text-[10px] text-zinc-400">
        Handler:{" "}
        <span className="font-mono text-zinc-600">
          {hex(peripheral.handlerAddress)}
        </span>
      </div>

      {/* Type-specific live controls — block pointer events from reaching React Flow */}
      <div
        className="nopan nodrag nowheel"
        onPointerDownCapture={stopPropagation}
      >
        {pType === "sensor" && (
          <SensorControls
            peripheralId={peripheral.id}
            meta={peripheral.meta}
            updatePeripheral={debouncedUpdate}
          />
        )}

        {pType === "timer" && (
          <TimerControls
            peripheralId={peripheral.id}
            meta={peripheral.meta}
            updatePeripheral={debouncedUpdate}
          />
        )}

        {pType === "hard-drive" && (
          <HardDriveControls
            peripheralId={peripheral.id}
            meta={peripheral.meta}
            updatePeripheralAction={debouncedUpdate}
          />
        )}

        {/* Trigger button for button-type peripherals */}
        {isInteractive && (
          <button
            onClick={() => triggerPeripheral(peripheral.id)}
            className="mt-2 w-full px-2 py-1 rounded-md bg-indigo-50 text-indigo-600
              text-[10px] font-medium hover:bg-indigo-100 transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={peripheral.status === "DISCONNECTED"}
          >
            Trigger
          </button>
        )}
      </div>

      {/* Source handle → connects to CPU interrupt line */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="w-2 h-2 bg-orange-400 border-orange-500"
      />
    </div>
  );
}
