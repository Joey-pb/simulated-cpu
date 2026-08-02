# Hard Drive Peripheral — a contribution to Simulated CPU

A memory-mapped, block-addressed **simulated hard disk** for the [Simulated CPU](#simulated-cpu) project: 4 KiB of persistent storage that the CPU drives through six control registers, with simulated seek latency, completion interrupts, an on-disk image file that survives restarts, and a live 16×16 sector browser in the visualizer.

![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![Peripheral](https://img.shields.io/badge/peripheral-hard--drive-orange)
![Status](https://img.shields.io/badge/status-working-brightgreen)

---

## Contribution & Attribution

The hard drive is an **addition to an existing project, not a project of my own**.

- **Host project:** [Simulated CPU](https://github.com/praiseisaac/simulated-cpu) — an 8-bit, dual-core CPU simulator with a React Flow visualizer, created and maintained by **Praise Daramola**.
- **This contribution:** the hard-drive peripheral and everything listed under [What This Contribution Adds](#what-this-contribution-adds), authored by **Joseph Bassett** ([@Joey-pb](https://github.com/Joey-pb)) as a **student contributor in an Open Avenues Build Fellowship project**, under Praise Daramola's direction.
- **Scope of this document:** everything above the [Simulated CPU](#simulated-cpu) divider documents the hard drive. The original project README follows below and is preserved as written, except for a small number of edits needed so the hard drive appears alongside the other peripherals.

The host project's design conventions — the `Peripheral` interface, the registry-driven wiring, memory-mapped I/O, the tick-deterministic clock — were followed deliberately rather than worked around. The goal was a device that looks like it always belonged in the codebase.

---

## Table of Contents

- [Why a Hard Drive?](#why-a-hard-drive)
- [What This Contribution Adds](#what-this-contribution-adds)
- [Disk Geometry](#disk-geometry)
- [The Register Interface](#the-register-interface)
- [The Command Protocol](#the-command-protocol)
- [Worked Example: Writing a Byte from a CPU Program](#worked-example-writing-a-byte-from-a-cpu-program)
- [Interrupts and ISRs](#interrupts-and-isrs)
- [Error Handling](#error-handling)
- [Persistence](#persistence)
- [Frontend: The Disk Browser](#frontend-the-disk-browser)
- [Integration Points](#integration-points)
- [Batch Loader Script](#batch-loader-script)
- [Testing](#testing)
- [Design Decisions](#design-decisions)
- [Known Limitations & Future Work](#known-limitations--future-work)
- [Quickstart](#quickstart)

---

## Why a Hard Drive?

Every peripheral that existed before this one was a **live-signal device**: a button, a timer, a sensor, an LED. They produce or consume a value in the moment and hold no meaningful history. Nothing in the simulator had *storage*.

A hard drive is a qualitatively different kind of device, and that is exactly what makes it worth building:

| Property | Existing peripherals | Hard drive |
|----------|---------------------|------------|
| State | Ephemeral, a value or two | 4 KiB of addressable blocks |
| CPU interface | One memory address | A six-register **command protocol** |
| Timing | Instantaneous | **Asynchronous** — a command completes several ticks after it is issued |
| Interrupt meaning | "Something happened" | "The operation you requested has finished" |
| Lifetime | Dies with the process | **Persists to disk**, survives restarts |

Concepts this exercises, all of which are how real storage controllers actually work: memory-mapped command/status registers, asynchronous device operations with seek latency, completion interrupts instead of busy-wait polling, CHS-style (cylinder/head/sector) block addressing, and separating device logic from the host's filesystem.

---

## What This Contribution Adds

Files the hard drive introduced, and the existing files it extended:

| File | | Role |
|------|--|------|
| `peripherals/HardDrive.peripheral.ts` | **added** | The device itself — registers, state machine, seek timing, storage buffer |
| `services/hdd/HDDPersistence.service.ts` | **added** | Node-only service that mirrors the drive's buffer to a disk-image file |
| `app/_components/HardDrive.component.tsx` | **added** | React panel: register readout, capacity bar, track selector, editable 16×16 sector grid, format button |
| `scripts/batch-load-hard-drive.ts` | **added** | Drives a queue of writes through the real CPU over the WebSocket, one completion interrupt at a time |
| `peripherals/registry.ts` | extended | Registers the `hard-drive` type so the server, the "Add Peripheral" panel, and the visualizer all learn about it from one place |
| `server/ws.ts` | extended | Constructs an `HDDPersistenceService` per drive instance and wires it to the drive's persistence callback |
| `app/_components/PeripheralNode.component.tsx` | extended | Type detection for `hard-drive`, renders the panel, widens the node card to fit the sector grid |
| `scripts/test-peripherals.ts` | extended | Adds test §14 — a full CPU-driven write, asserted against the disk buffer |
| `package.json` | extended | Adds the `load-hd` script; switches `dev:all` to `concurrently` so it runs on Windows |
| `.gitignore` | extended | Ignores `/data/`, where disk images live |

---

## Disk Geometry

```
16 tracks  ×  16 sectors/track  ×  16 bytes/sector  =  4096 bytes (4 KiB)
```

The drive is deliberately **four times larger than the CPU's entire 1 KB address space**. It cannot be memory-mapped in full, which is the whole point: storage that exceeds addressable memory has to be reached a block at a time through a controller, and that constraint is what forces the command-register design below.

A track/sector/offset triple collapses to a flat index into the backing buffer:

```
index = track × (SECTORS_PER_TRACK × BYTES_PER_SECTOR)
      + sector × BYTES_PER_SECTOR
      + offset

e.g. track 2, sector 3, offset 5  →  2×256 + 3×16 + 5  =  565
```

The same arithmetic appears in three places, intentionally kept in sync: `getDiskIndex()` in the peripheral, `cellValue()` in the React panel, and the assertion in test §14.

---

## The Register Interface

The CPU never calls a method on the drive. It communicates the way real hardware does — by reading and writing six fixed addresses that the drive watches, occupying the **top of the 1 KB address space** (`0x000`–`0x3FF`):

| Address | Register | Written by | Meaning |
|---------|----------|-----------|---------|
| `0x3F0` | `CMD` | CPU | Command to execute. The drive clears it to `NOP` on completion. |
| `0x3F1` | `TRACK` | CPU | Target track, 0–15 |
| `0x3F2` | `SECTOR` | CPU | Target sector, 0–15 |
| `0x3F3` | `OFFSET` | CPU | Byte offset within the sector, 0–15 |
| `0x3F4` | `DATA` | both | Payload for a `WRITE`; result of a `READ` |
| `0x3F5` | `STATUS` | drive | Current drive state — maintained by the drive, never written by the CPU |

> **Address-space note.** These six bytes are ordinary RAM that the drive has claimed. A program that uses `0x3F0`–`0x3F5` as scratch space will fight the drive for them. They sit at the very top of memory because programs load from low addresses upward, which keeps the collision risk as low as the 1 KB space allows.

**Command values (`CMD`)**

| Value | Name | Effect |
|-------|------|--------|
| `0x00` | `NOP` | Idle — no command pending |
| `0x01` | `READ` | Copy the addressed disk byte into `DATA` |
| `0x02` | `WRITE` | Copy `DATA` into the addressed disk byte |

**Status values (`STATUS`)**

| Value | Name | Meaning |
|-------|------|---------|
| `0x01` | `IDLE` | Ready to accept a command |
| `0x02` | `BUSY` | Seeking — command latched, not yet executed |
| `0x03` | `DONE` | Last operation completed (transient — see below) |
| `0x04` | `ERROR` | Invalid command or out-of-range address |

---

## The Command Protocol

```
        ┌──────────────────────────────────────────────┐
        │                                              │
        ▼                                              │
   ┌─────────┐   CPU writes CMD    ┌────────┐  seek   │
   │  IDLE   │────────────────────▶│  BUSY  │─ ─ ─ ─ ─┤
   └─────────┘                     └────────┘   done  │
        ▲                               │             │
        │                               │ bad address │
        │  next tick (CMD == NOP)       ▼             ▼
        │                          ┌────────┐    ┌────────┐
        └──────────────────────────│  DONE  │    │ ERROR  │
                                   └────────┘    └────────┘
                                    + interrupt    + throw
```

Issuing a command is five stores:

1. `STORE` the track into `0x3F1`
2. `STORE` the sector into `0x3F2`
3. `STORE` the offset into `0x3F3`
4. `STORE` the payload into `0x3F4` (writes only)
5. `STORE` `READ` or `WRITE` into `0x3F0` — **this is the trigger**

The drive does nothing until step 5. Writing `CMD` last is what makes the sequence atomic from the drive's point of view.

### Timing

The simulator's tick order is *scheduler → peripherals → interrupts → cores*, so a store performed by a core in cycle *N* is first observed by the drive in cycle *N+1*. With `SEEK_TICKS = 2`:

| Cycle | What happens | `CMD` | `STATUS` | Internals |
|-------|-------------|-------|----------|-----------|
| N | Core executes `STORE R0, 0x3F0` | `WRITE` | `IDLE` | idle |
| N+1 | Drive latches the command, validates the address | `WRITE` | `BUSY` | `busyCounter = 2` |
| N+2 | Drive seeks | `WRITE` | `BUSY` | `busyCounter = 1` |
| N+3 | Drive executes the transfer and **fires its interrupt** | `NOP` | `DONE` | `busyCounter = 0` |
| N+4 | Drive observes `CMD == NOP` | `NOP` | `IDLE` | ready for the next command |

Three cycles from store to completion interrupt. The seek delay exists for two reasons: it models the mechanical latency that makes real disk I/O asynchronous, and it holds `BUSY` on screen long enough to actually see at normal clock speeds.

> **`DONE` is transient.** It is visible for exactly one tick before the drive returns to `IDLE`. An ISR must therefore treat the *interrupt itself* as the completion signal and read `DATA` immediately — polling `STATUS` for `DONE` is a race the ISR will usually lose. This is deliberate: it is the reason completion interrupts exist in real hardware.

---

## Worked Example: Writing a Byte from a CPU Program

This is the program from test §14. It writes `0x42` to track 2, sector 3, offset 5. Every instruction is 4 bytes: `[opcode] [register] [addr_high] [addr_low]`.

```asm
; ─── scratch data ──────────────────────────────
; 0x080 = 2      track
; 0x081 = 3      sector
; 0x082 = 5      offset
; 0x083 = 0x42   value to store
; 0x084 = 0x02   CMD.WRITE

LOAD  R0, 0x080      ; 01 00 00 80   R0 = track
STORE R0, 0x3F1      ; 02 00 03 F1   → TRACK
LOAD  R1, 0x081      ; 01 01 00 81   R1 = sector
STORE R1, 0x3F2      ; 02 01 03 F2   → SECTOR
LOAD  R2, 0x082      ; 01 02 00 82   R2 = offset
STORE R2, 0x3F3      ; 02 02 03 F3   → OFFSET
LOAD  R3, 0x083      ; 01 03 00 83   R3 = 0x42
STORE R3, 0x3F4      ; 02 03 03 F4   → DATA
LOAD  R0, 0x084      ; 01 00 00 84   R0 = CMD.WRITE  (R0 is free again)
STORE R0, 0x3F0      ; 02 00 03 F0   → CMD  ◀── triggers the seek
HALT                 ; FF 00 00 00
```

Three cycles later the drive fires its interrupt and `diskStorage[565] == 0x42`.

A `READ` is the same program without the `DATA` store, using `CMD.READ` instead; the requested byte is in `0x3F4` by the time the interrupt arrives. Note that only four registers exist, so `R0` is reused for the command — with five values to place and four registers, register reuse isn't a stylistic choice.

---

## Interrupts and ISRs

On completion the drive returns an interrupt with:

| Field | Value |
|-------|-------|
| `source` | The peripheral's id, e.g. `hd1` |
| `priority` | `2` by default — medium (0 is most urgent) |
| `handlerAddress` | `0x00D0` by default |
| `timestamp` | `Date.now()` |

Medium priority is a judgement call: disk completion is more urgent than a periodic timer, because the drive is idle and unusable until the result is consumed, but less urgent than a user-facing input event.

### No auto-generated ISR — on purpose

`server/ws.ts` auto-installs a small counter-incrementing ISR for peripheral types that declare a `dataAddress` in the registry. The hard-drive entry deliberately **omits `dataAddress`**, so no ISR is generated for it.

The reason: a generic "increment a counter" handler is meaningless for a drive. A real handler has to consume `DATA` before the next command overwrites it, and only the program that issued the read knows where that byte should go. Fabricating a handler would teach the wrong lesson.

The consequence, which is worth knowing before you enable interrupt-driven flows: **memory is zeroed on reset, and `0x00` is `NOP`**, so an interrupt delivered to an empty `0x00D0` executes `NOP`s forever and never returns via `IRET`. Load at minimum a bare return before relying on the interrupt:

```ts
// Minimal do-nothing handler: IRET
memory.loadProgram(0x00D0, [0xFE, 0x00, 0x00, 0x00]);
```

A useful handler reads `DATA` and stores it somewhere the main program will look:

```asm
; ISR at 0x00D0 — stash the byte the drive just read
LOAD  R0, 0x3F4      ; 01 00 03 F4   R0 = DATA
STORE R0, 0x0090     ; 02 00 00 90   → application buffer
IRET                 ; FE 00 00 00
```

---

## Error Handling

The drive fails loudly rather than silently doing something plausible.

| Condition | Result |
|-----------|--------|
| `CMD` is not `NOP`, `READ`, or `WRITE` | `STATUS = ERROR`, `CMD` cleared, `Error` thrown |
| Track, sector, or offset out of range | `STATUS = ERROR`, `CMD` cleared, `RangeError` thrown with the offending triple |
| UI cell edit with an out-of-range address or a value outside `0x00`–`0xFF` | `RangeError` thrown, **registers untouched** |

Two details are intentional:

**Errors set the status register *before* throwing.** The CPU-visible state is coherent at the moment the exception leaves `tick()`, so anything inspecting memory afterwards sees `ERROR` rather than a stale `BUSY`.

**`writeCell()` does not set `ERROR`.** It is the UI's direct-edit path and bypasses the CPU entirely, so a mistyped value in the browser has no business poisoning registers that a running program is reading. It throws, and the drive's own state is left alone.

Where a thrown error lands depends on how the clock is running — both callers already handle it:

- **Free-running clock:** `CPUService.start()` catches it, stops the clock, and logs `[CPU] Tick error — auto-stopped`.
- **Manual step over the WebSocket:** `server/ws.ts` catches it, stops the CPU, and sends `{ type: "error", message }` to the browser.

Note that `PeripheralManager.tickAll()` does not catch — a device fault propagates up to the clock owner rather than being swallowed mid-tick.

---

## Persistence

### The drive knows nothing about the filesystem

`HardDrive.peripheral.ts` contains **no `fs` import**, and this is a hard constraint rather than a preference: `app/_components/HardDrive.component.tsx` imports the `CMD` and `STATUS` enums from that same file, so the peripheral module is reachable from the browser bundle. A single `node:fs` import there would break the client build.

The device therefore exposes exactly two seams:

```ts
get storage(): Uint8Array                     // live reference to the backing buffer
setPersistenceHandler(cb): void               // called after every completed WRITE
```

If no handler is registered, the drive still works perfectly — writes just aren't durable. Persistence is strictly opt-in, added from the outside by whoever owns the process.

### `HDDPersistenceService`

`services/hdd/HDDPersistence.service.ts` is Node-only and owns all filesystem contact.

**On construction** it takes the image path and a live reference to the drive's buffer:

- If the image exists **and its length matches the buffer**, its bytes are copied into the buffer in place, so the drive boots with whatever was last saved. A length mismatch — a stale image from a different geometry — is ignored rather than truncated or padded.
- If the image doesn't exist, the parent directory is created and loading is skipped. The file is created lazily on the first write.

**On write** it is called with the index of the byte that changed:

- **With `changedIndex`** (the normal path, once per completed `WRITE`) it opens the file and rewrites **that single byte in place** at that file position. A one-byte disk write costs a one-byte file write, not a 4 KiB rewrite.
- **Without `changedIndex`** (bulk operations such as `formatDisk()`) it overwrites the whole file.

**All failures are caught, logged, and swallowed.** A permission error or a vanished file must not throw back through `HardDrive.tick()` and take down the CPU loop — losing durability is recoverable, crashing the simulation mid-cycle is not.

### Wiring

`server/ws.ts` connects the two halves at creation time, in the one place that already knows it is running under Node:

```ts
if (peripheralType === "hard-drive") {
  const drive = peripheral as HardDrive;
  // Constructing this seeds drive.storage from the existing image, in place.
  const persistence = new HDDPersistenceService(DISK_IMAGE_PATH, drive.storage);
  drive.setPersistenceHandler((storage, changedIndex) =>
    persistence.persistData(changedIndex),
  );
}
```

### End-to-end lifecycle

```
  browser                server/ws.ts              HardDrive            HDDPersistence
     │                        │                        │                       │
     │  registerPeripheral    │                        │                       │
     ├───────────────────────▶│  create ──────────────▶│                       │
     │                        │  new HDDPersistence ───┼──────────────────────▶│
     │                        │                        │◀── seed storage ──────┤  read data/disk.img
     │                        │  setPersistenceHandler▶│                       │
     │                        │                        │                       │
     │  (CPU program runs) ───┼───▶ STORE 0x3F0 ──────▶│  seek → write byte    │
     │                        │                        ├── onWrite(idx) ──────▶│  writeSync 1 byte
     │◀── snapshot broadcast ─┤◀── toJSON() ───────────┤                       │
```

The buffer inside the drive is authoritative at all times; the image file trails it by one write. Nothing reads the file back except a fresh drive at construction.

The image lives at `data/disk.img` (created on demand, `/data/` is gitignored). Delete it for a clean disk, or use the panel's **Format Disk** button, which zeroes the buffer and rewrites the whole image.

---

## Frontend: The Disk Browser

Because the peripheral is registered in `registry.ts`, it appears in the **Add Peripheral** panel automatically — that panel is built by mapping over `PERIPHERAL_REGISTRY`. The entry declares `fields: []`, so the drive is added with no configuration beyond its name, handler address, and priority.

`PeripheralNode.component.tsx` identifies the device by the shape of its snapshot meta rather than a type string, matching the existing convention:

```ts
if ("diskStorage" in meta && "cmdAddress" in meta) return "hard-drive";
```

The panel shows:

- **Live register readout** — `CMD` (with its mnemonic), `TRACK`, `SECTOR`, `OFFSET`, `DATA`, and a colour-coded `STATUS`: grey `IDLE`, amber `BUSY`, green `DONE`, red `ERROR`
- **Address reference line** — the six register addresses, so you can write a program against them without leaving the canvas
- **Capacity bar** — bytes used out of 4096, with a percentage and free count
- **Track selector** — a slider across all 16 tracks
- **Sector grid** — a 16×16 hex grid for the selected track (rows are sectors, columns are byte offsets). Nonzero bytes are green, zero bytes grey; hovering shows `T:S:O = 0xNN`
- **Click-to-edit** — clicking any cell opens an inline hex input (Enter commits, Escape cancels) that writes straight into the buffer, bypassing the CPU
- **Format Disk** — zeroes the drive and the image file

Edits flow back through the existing debounced update channel (150 ms coalescing, reusing the node's `useDebouncedUpdate`) → `updatePeripheral` over the WebSocket → the registry's `applyUpdates` → `HardDrive.writeCell()`. Updates carrying `{ track, sector, offset, value }` write a cell; `{ format: true }` formats.

Read-side data flow is just the existing snapshot broadcast: `toJSON()` serializes the whole 4096-byte buffer plus every live register value into `meta`, which the server already broadcasts each tick.

One shared-component change was needed: the peripheral card's width went from `min-w-48 max-w-56` to `min-w-64 max-w-96`. A 16-column hex grid does not fit in the original card, and widening the shared card was less invasive than special-casing width by peripheral type.

---

## Integration Points

The device touches four subsystems. Each was extended along its existing seam rather than around it:

| Subsystem | Seam used | What was added |
|-----------|-----------|----------------|
| **Peripheral system** | `Peripheral<TMeta>` interface | `HardDrive` implements `connect`/`disconnect`/`tick`/`trigger`/`toJSON` like every other device |
| **Registry** | `PERIPHERAL_REGISTRY` entry | One entry supplies the type, factory, and `applyUpdates` handler — the server, panel, and visualizer all read from it |
| **Memory** | `MemoryService.read/write` | Registers are ordinary memory addresses, so register traffic shows up in the Memory node's access events like any other I/O |
| **WebSocket server** | `createPeripheral()` | Per-instance persistence wiring, the only hard-drive-specific code outside the peripheral itself |
| **Visualizer** | `detectType()` + node body | Meta-shape detection and a dedicated controls component |

`trigger()` — the manual-interaction hook the UI calls — is implemented as a **cancel/reset**: it clears any in-flight seek and returns the drive to `IDLE` with `CMD = NOP`. There is no meaningful "press" gesture for a disk, and an escape hatch out of a stuck `BUSY` is more useful than a no-op.

---

## Batch Loader Script

`scripts/batch-load-hard-drive.ts` populates the disk **through the real CPU** rather than by poking the buffer — every byte is written by an actual assembled program going through the actual register protocol.

```bash
npm run dev:all      # terminal 1 — server + frontend
npm run load-hd      # terminal 2
```

For each entry in its `WRITES` queue it:

1. Assembles the 11-instruction write program shown above, plus its scratch data
2. Sends `loadProgram` for both regions, then `addProcess`, then `start`
3. **Waits for the drive's completion interrupt** to appear in `interruptSources` before starting the next write
4. Arms a timeout of `(instructions + SEEK_TICKS + SLACK_TICKS) × CLOCK_MS + 500 ms` and aborts loudly if a write never completes

Waiting on the interrupt rather than a fixed delay is the point of the script: it is a working demonstration of interrupt-driven flow control, and it doubles as an end-to-end integration test across the WebSocket, scheduler, CPU, drive, and persistence layer.

The default payload spells `Hello World!!!` in ASCII across track 0, sector 0 — visible immediately in the panel grid, and still there after a server restart. A commented-out generator for bulk fill patterns sits below it. `SEEK_TICKS` is mirrored from the peripheral as a constant; the two must be updated together.

---

## Testing

```bash
npm run test-peripherals
```

Section **§14 — Hard Drive: CPU-driven WRITE** was added to the existing suite. It is a full-stack test in miniature: a real `MemoryService`, a real `CPUService`, a real `HardDrive`, and the real program listed above. It steps the CPU until `hd1` appears in `interruptSources`, then asserts that `diskStorage[565]` is `0x42` — verifying the register protocol, the seek countdown, the completion interrupt, and the index arithmetic in a single pass.

The persistence service is exercised end-to-end by `npm run load-hd` (write, restart the server, confirm the bytes are still there) rather than by a unit test — see [Known Limitations](#known-limitations--future-work).

---

## Design Decisions

| Decision | Alternative considered | Why |
|----------|----------------------|-----|
| Six-register command protocol | A method the UI or CPU calls directly | The CPU can only read and write memory. Anything else would be a fiction that no real program could use. |
| `CMD` written last as the trigger | A separate "go" bit | Gives the sequence a single unambiguous commit point; the drive never sees a half-configured address. |
| 2-tick seek latency | Complete instantly | Instant completion makes the interrupt pointless and hides `BUSY` from the UI. Latency is what makes the device asynchronous. |
| Completion interrupt | Let the CPU poll `STATUS` | Polling burns cycles and, since `DONE` lasts one tick, would usually miss it. This mirrors real controllers. |
| Callback-based persistence | Import `fs` in the peripheral | The peripheral module is imported by the React panel; a `node:fs` import there breaks the browser bundle. |
| Single-byte file writes | Rewrite the 4 KiB image each time | One disk byte changes per command, so writing one file byte is proportionate. Full rewrites are reserved for `formatDisk()`. |
| Persistence errors swallowed | Propagate them | A durability failure must not crash the CPU loop mid-tick. |
| Throw on a bad address | Clamp or wrap silently | Silent clamping writes real data to the wrong place. A `RangeError` naming the triple is debuggable; a mystery byte is not. |
| Buffer is authoritative, file trails | Read through to the file | Keeps the drive fully functional with no persistence handler attached, and keeps the tick path off the filesystem's read side. |
| Nonzero bytes counted as "used" | Track allocation metadata | There is no filesystem on this disk, so there is no allocation table to consult. Documented as an approximation. |
| 4 KiB — larger than RAM | Fit the disk inside the address space | A disk smaller than memory has no reason to exist. Exceeding the address space is what motivates block-at-a-time access. |

---

## Known Limitations & Future Work

Honest boundaries of the current implementation:

- **One image path for all drives.** `DISK_IMAGE_PATH` is a single constant in `server/ws.ts`, so a second hard-drive instance would share `data/disk.img` with the first and the two would overwrite each other. Deriving the path from the peripheral id (`data/<id>.img`) is the obvious fix.
- **No ISR is installed by default.** As described above, an interrupt delivered to a zeroed `0x00D0` runs `NOP`s and never returns. Load a handler before relying on interrupt-driven flows.
- **Synchronous filesystem calls on the tick path.** `writeSync` blocks the clock. At simulator scale this is imperceptible, but a batched or async writer would be the right approach for a larger disk.
- **One byte per command.** Real drives transfer whole sectors. Multi-byte transfers would need either a length register or a DMA-style burst.
- **Capacity accounting is heuristic.** A byte legitimately storing `0x00` is counted as free.
- **`writeCell()` ignores `BUSY`.** A UI edit during an in-flight seek isn't blocked, so it can land on a byte the CPU is about to overwrite. `formatDisk()` *does* check `busyCounter` and refuses to run mid-seek — the two paths should be consistent.
- **No unit tests for `HDDPersistenceService`.** It is covered end-to-end by the batch loader, but load-on-construct, the length-mismatch guard, and the single-byte write path each deserve direct tests against a temp file.
- **No `READ` test in the suite.** §14 covers the write path; the read path is verified manually through the UI and the batch loader.
- **No error simulation.** Bad sectors, checksums, and read-verification failures would be a natural next layer.

---

## Quickstart

```bash
npm install
npm run dev:all          # WS server on :3006, frontend on :3005
```

Then, in the browser at [http://localhost:3005](http://localhost:3005):

1. Open **Add Peripheral** (top right) and choose **Hard Drive**
2. The node appears with `STATUS: IDLE` and an empty 16×16 grid
3. Click any cell, type two hex digits, press Enter — the byte is written and persisted immediately
4. Restart the server and re-add the drive: the byte is still there, loaded back from `data/disk.img`

To watch the CPU drive it instead, run `npm run load-hd` in a second terminal and watch `STATUS` cycle `IDLE → BUSY → DONE` as `Hello World!!!` fills track 0, sector 0.

Verify with the test suite:

```bash
npm run test-peripherals   # includes §14 — CPU-driven WRITE
```

---
---

# Simulated CPU

> The original project README, by Praise Daramola, begins here.

A fully interactive CPU simulation with a real-time visual frontend. Built to teach how a processor fetches, decodes, and executes instructions — complete with multi-core scheduling, interrupt handling, memory-mapped I/O, and pluggable peripheral devices.

![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![Next.js](https://img.shields.io/badge/Next.js-16-black)
![React Flow](https://img.shields.io/badge/React%20Flow-12-purple)

## What Is This?

This project simulates a simple computer from scratch. If you've ever wondered what happens when you press a button on a keyboard, how a CPU runs multiple programs at once, or how hardware devices talk to software — this simulator shows you all of it visually, in real time.

You'll see:
- A **CPU** fetching instructions from memory and executing them step by step
- A **scheduler** deciding which program gets to run next
- **Peripherals** (buttons, sensors, LEDs) sending signals to the CPU
- **Memory** being read and written as programs execute

## Key Concepts

If you're new to these topics, here's a quick primer on the core ideas this simulator demonstrates.

### What Is a CPU?

A CPU (Central Processing Unit) is the "brain" of a computer. It reads instructions from memory one at a time and executes them. Our simulated CPU is an **8-bit, dual-core processor** — meaning:

- **8-bit**: It works with numbers from 0 to 255
- **Dual-core**: It has two independent processing units that can run programs at the same time

### The Fetch-Decode-Execute Cycle

Every CPU follows this loop:

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│  FETCH   │────▶│  DECODE  │────▶│ EXECUTE  │
│          │     │          │     │          │
│ Read the │     │ Figure   │     │ Do the   │
│ next     │     │ out what │     │ actual   │
│ instruc- │     │ it means │     │ work     │
│ tion     │     │          │     │          │
└──────────┘     └──────────┘     └──────────┘
     ▲                                 │
     └─────────────────────────────────┘
              (repeat forever)
```

1. **Fetch** — Read the next instruction's bytes from memory
2. **Decode** — Parse those bytes to figure out the operation (e.g., "add two registers")
3. **Execute** — Perform the operation (e.g., add R0 + R1, store result)

In this simulator, each stage takes one clock tick, so you can watch each step happen.

### Registers

Registers are tiny, fast storage slots inside the CPU. Our CPU has 4 registers:

| Register | Purpose |
|----------|---------|
| R0 | General purpose |
| R1 | General purpose |
| R2 | General purpose |
| R3 | General purpose |

Each holds a single byte (0–255). Programs use registers for calculations because accessing them is instant, unlike memory which takes a whole cycle to read.

### Instructions (ISA)

ISA stands for **Instruction Set Architecture** — the list of commands a CPU understands. Our CPU has 8 instructions:

| Opcode | Mnemonic | Example | What It Does |
|--------|----------|---------|-------------|
| `0x00` | `NOP` | `NOP` | Do nothing (no operation) |
| `0x01` | `LOAD` | `LOAD R0, 0x0038` | Copy a value from memory into a register |
| `0x02` | `STORE` | `STORE R0, 0x0038` | Copy a register's value into memory |
| `0x03` | `ADD` | `ADD R0, R1` | Add two registers (result goes in the first) |
| `0x04` | `SUB` | `SUB R0, R1` | Subtract second register from first |
| `0x05` | `JMP` | `JMP 0x0100` | Jump to a different address (change the program counter) |
| `0xFE` | `IRET` | `IRET` | Return from an interrupt handler |
| `0xFF` | `HALT` | `HALT` | Stop the program |

Each instruction is encoded as **4 bytes**:
```
[opcode] [operand1] [operand2_high] [operand2_low]
```

### Memory

Memory is where programs and data live. Our simulator has **1 KB (1024 bytes)** of memory, addressable from `0x000` to `0x3FF`.

- Programs are loaded into memory as sequences of bytes
- The CPU reads instructions from memory using the program counter
- Peripherals can read/write specific memory addresses (memory-mapped I/O)

### Interrupts

An interrupt is a signal from a peripheral device saying "I need attention!" When an interrupt fires:

1. The CPU **saves** the current program's state (registers, program counter)
2. The CPU **jumps** to a special routine called an ISR (Interrupt Service Routine)
3. The ISR handles the interrupt (e.g., reads a sensor value)
4. The ISR executes `IRET` to **restore** the saved state and resume the original program

This is how real computers handle keyboard presses, mouse clicks, network packets, and more — without the running program needing to constantly check for them.

### Process Scheduling

When multiple programs need to run but there are limited CPU cores, a **scheduler** decides who runs when. This simulator supports three strategies:

| Algorithm | How It Works |
|-----------|-------------|
| **Round Robin** | Each program gets a fixed time slice (4 cycles), then the next program takes over. Fair but not urgent. |
| **Preemptive Priority** | Important programs can interrupt less important ones mid-execution. Fast for high-priority tasks. |
| **Non-Preemptive** | A program runs until it finishes. Simple but can starve other programs. |

### Peripherals

Peripherals are hardware devices attached to the CPU — buttons, sensors, displays, LEDs. They communicate with the CPU in two ways:

- **Interrupts** — "Hey CPU, something happened!" (input devices like buttons)
- **Memory-mapped I/O** — The CPU reads/writes specific memory addresses that the peripheral monitors (output devices like screens)

See the [peripherals README](peripherals/README.md) for details on each device and how to create your own.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Next.js Frontend                 │
│   React Flow Canvas · Custom Nodes · Controls    │
│                                                   │
│   CPUNode · MemoryNode · PeripheralNodes         │
└──────────────────────┬──────────────────────────┘
                       │ WebSocket (port 3006)
┌──────────────────────▼──────────────────────────┐
│               WebSocket Server                    │
│         Command Router · State Broadcaster        │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              Simulation Services                  │
│                                                   │
│  ┌─────────┐  ┌──────────┐  ┌────────────────┐  │
│  │   CPU    │  │  Memory  │  │  Peripheral    │  │
│  │ 2 Cores │  │  1 KB    │  │  Manager       │  │
│  │ Scheduler│  │  8-bit   │  │  8 Devices     │  │
│  │ Interrupts│ │  Events  │  │  Interrupts    │  │
│  └─────────┘  └──────────┘  └────────────────┘  │
│                                                   │
│  ┌────────────────────────────────────────────┐  │
│  │          Tick Sequence (each cycle)         │  │
│  │  1. Scheduler → 2. Peripherals →           │  │
│  │  3. Interrupts → 4. Core Execute           │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## Getting Started

### Prerequisites

- **Node.js 20+** — [Download here](https://nodejs.org/). Check with `node --version`
- **npm** — Comes with Node.js. Check with `npm --version`

### Installation

```bash
# Clone the repository
git clone https://github.com/praiseisaac/simulated-cpu.git

# Navigate into the project
cd simulated-cpu

# Install dependencies
npm install
```

### Running the Simulator

Start both the simulation server and the visual frontend with one command:

```bash
npm run dev:all
```

This launches:
- **WebSocket server** on `ws://localhost:3006` (the simulation engine)
- **Next.js frontend** on `http://localhost:3005` (the visual interface)

Open [http://localhost:3005](http://localhost:3005) in your browser to see the simulator.

### Running Components Individually

```bash
# WebSocket server only (simulation backend)
npm run ws

# Next.js frontend only (requires the WS server to be running separately)
npm run dev
```

### Running Tests

Validate that each part of the simulator works correctly:

```bash
npm run test-cpu          # Test CPU fetch/decode/execute pipeline
npm run test-memory       # Test memory read/write/bounds
npm run test-interrupts   # Test interrupt priority queue
npm run test-peripherals  # Test peripheral tick/trigger behavior
npm run test-persistence  # Test save/load snapshots
```

The hard drive also ships a live end-to-end loader, which writes bytes to the disk through real CPU programs over the WebSocket (requires `npm run dev:all` to be running):

```bash
npm run load-hd           # Batch-write bytes to the Hard Drive peripheral
```

## Using the Simulator

Once the simulator is running in your browser:

1. **Add a process** — Click the controls to load a program into memory and schedule it for execution
2. **Start the clock** — Click "Start" to begin the fetch-decode-execute cycle
3. **Watch the pipeline** — See each core's registers, flags, and pipeline stage update in real time
4. **Add peripherals** — Use the panel in the top-right to add buttons, sensors, LEDs, etc.
5. **Trigger devices** — Click on a button peripheral to fire an interrupt and watch the CPU handle it
6. **Step through** — Use "Step" to advance one tick at a time for detailed observation
7. **Adjust speed** — Use the clock speed slider to slow down or speed up the simulation
8. **Change scheduling** — Switch between Round Robin, Preemptive Priority, and Non-Preemptive to see how they behave differently

## Peripherals

The simulator comes with 8 built-in peripherals:

| Peripheral | Type | What It Does |
|-----------|------|-------------|
| **Button** | Input | One-shot interrupt on press |
| **Timer** | Input | Periodic interrupt every N ticks |
| **Sensor** | Input | Fires when a value crosses a threshold |
| **Proximity Sensor** | Input | Detects cursor distance, writes to memory |
| **Potentiometer** | Input | Analog slider, writes 0–255 to memory |
| **Screen** | Output | Scrolling waveform display from memory |
| **LED** | Output | On/off indicator from memory value |
| **Hard Drive** | Input | 4 KiB block storage driven by memory-mapped command registers; fires a completion interrupt and persists to a disk image — [full documentation above](#hard-drive-peripheral--a-contribution-to-simulated-cpu) |

### Creating Your Own Peripheral

Want to build a custom peripheral? See the **[Peripherals README](peripherals/README.md)** for a complete guide with:
- The interface your peripheral must implement
- A full starter template (Buzzer example)
- Step-by-step instructions for wiring it into the server and frontend
- Ideas for peripherals you could build

## Project Structure

```
simulated-cpu/
├── app/                    # Frontend (Next.js + React Flow)
│   ├── page.tsx            # Main canvas with CPU, Memory, Peripheral nodes
│   ├── _components/        # Visual components for each node type
│   └── _modules/           # WebSocket connection and shared state
├── services/               # Core simulation logic (pure TypeScript)
│   ├── cpu/                # CPU, Core, Scheduler, Interrupts, Decoder
│   ├── hdd/                # Hard-drive disk-image persistence (Node-only)
│   ├── Memory.service.ts   # 1 KB main memory
│   └── PeripheralManager.service.ts
├── peripherals/            # Peripheral device implementations
├── types/                  # TypeScript type definitions
├── server/                 # WebSocket server (simulation ↔ frontend bridge)
│   └── ws.ts
├── scripts/                # Test scripts and the hard-drive batch loader
└── data/                   # Hard-drive disk images (gitignored, created on demand)
```

Each directory has its own README with detailed documentation:

| Directory | README | What's Inside |
|-----------|--------|--------------|
| [`peripherals/`](peripherals/README.md) | Peripheral devices and how to create new ones | |
| [`services/`](services/README.md) | Core simulation services (CPU, Memory, Scheduler) | |
| [`types/`](types/README.md) | TypeScript type definitions | |
| [`app/`](app/README.md) | Frontend visualizer (React Flow canvas) | |
| [`server/`](server/README.md) | WebSocket server bridge | |
| [`scripts/`](scripts/README.md) | Test scripts | |

## Tech Stack

| Layer | Technology | What It Does |
|-------|-----------|-------------|
| Frontend | Next.js 16, React 19, Tailwind CSS 4 | Web application framework and styling |
| Visualizer | @xyflow/react 12 (React Flow) | Interactive node-and-edge canvas |
| Backend | WebSocket server (ws library) | Real-time communication between simulation and browser |
| Language | TypeScript 5 | Type-safe JavaScript |
| Runner | tsx | Runs TypeScript files directly without a build step |

## Design Principles

- **Event-driven** — Components communicate through events and listeners, not direct calls
- **Tick-deterministic** — The entire system advances via a single clock: scheduler → peripherals → interrupts → cores
- **Separation of concerns** — Simulation logic is pure TypeScript with no framework dependencies; the frontend is a read-only view
- **Memory-mapped I/O** — Peripherals communicate via fixed memory addresses, just like real hardware

## License

MIT
