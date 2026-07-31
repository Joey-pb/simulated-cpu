"use client";

import { CMD, STATUS } from "@/peripherals/HardDrive.peripheral";
import { useState } from "react";

  const SLIDER_CLASS =
    "w-full h-1 rounded-full appearance-none bg-zinc-200 accent-blue-500 cursor-pointer nopan";

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
  const totalBytes = (meta.totalBytes as number) ?? 0x3f0;
  const cmdAddress = (meta.cmdAddress as number) ?? 0x3f0;
  const trackAddress = (meta.trackAddress as number) ?? 0x3f1;
  const sectorAddress = (meta.sectorAddress as number) ?? 0x3f2;
  const offsetAddress = (meta.offsetAddress as number) ?? 0x3f3;
  const dataAddress = (meta.dataAddress as number) ?? 0x3f4;
  const statusAddress = (meta.statusAddress as number) ?? 0x3f5;

  // Disk usage.
  const usedBytes = diskStorage.reduce((n, b) => (b !== 0 ? n + 1 : n), 0);
  const freeBytes = totalBytes - usedBytes;
  const usedPct =
    totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

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
    setEditValue("");
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

      {/* Space usage — nonzero bytes counted as "used" */}
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-[9px] font-mono text-zinc-500">
          <span>
            {usedBytes} / {totalBytes} bytes used
          </span>
          <span>
            {usedPct}% · {freeBytes} free
          </span>
        </div>
        <div className="w-full h-1.5 rounded-full bg-zinc-100 overflow-hidden">
          <div
            className="h-full bg-indigo-500 transition-all"
            style={{ width: `${usedPct}%` }}
          />
        </div>
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
                  className={`flex items-center justify-center h-5 px-1 py-0.5 cursor-pointer transition-colors bg-white hover:bg-indigo-50 
                    ${isSet ? "text-green-600" : "text-zinc-300"}`}
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

      {/* Format Disk */}
      <button
        onClick={() => updatePeripheralAction(peripheralId, { format: true })}
        className="w-full px-2 py-1 rounded-md bg-red-50 text-red-600
          text-[10px] font-medium hover:bg-red-100 transition-colors"
      >
        Format Disk
      </button>
    </div>
  );
}