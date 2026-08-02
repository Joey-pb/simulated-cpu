# Scripts

Test scripts that validate individual services work correctly, plus one live tool that drives a running simulator over the WebSocket. Run them to check that the simulation logic is behaving as expected.

## Running Tests

```bash
npm run test-cpu          # CPU pipeline: fetch, decode, execute all 8 instructions
npm run test-memory       # Memory: read, write, bounds checking, bulk loads
npm run test-interrupts   # Interrupt controller: priority queue ordering
npm run test-peripherals  # Peripherals: tick/trigger behavior, interrupt generation
npm run test-persistence  # Persistence: save/load round-trips
```

Each script runs standalone with `tsx` (TypeScript execution) and prints results to the console.

## Live Tools

Unlike the tests above, these connect to a **running** simulator, so start it first:

```bash
npm run dev:all           # terminal 1 — WS server on :3006, frontend on :3005
npm run load-hd           # terminal 2 — batch-write bytes to the Hard Drive
```

## Files

| Script | What It Tests |
|--------|--------------|
| `test-cpu.ts` | Creates a CPU, loads a program, runs it through the pipeline, and verifies register/memory values after execution |
| `test-memory.ts` | Tests reading and writing bytes, out-of-bounds access errors, program loading, and memory dumps |
| `test-interrupts.ts` | Tests interrupt priority queue ordering — ensures higher-priority interrupts are dequeued first |
| `test-peripherals.ts` | Tests each peripheral type: button arm/fire, timer periodic firing, sensor threshold crossing, and (§14) a full CPU-driven hard-drive write asserted against the disk buffer |
| `test-persistence.ts` | Saves a CPU snapshot to JSON, loads it back, and verifies the state matches |
| `batch-load-hard-drive.ts` | **Live tool, not a test.** Writes a queue of bytes to the Hard Drive through real assembled CPU programs sent over the WebSocket, waiting for each write's completion interrupt before sending the next |

### batch-load-hard-drive.ts

For every byte in its `WRITES` queue the script assembles an 11-instruction program that loads the track, sector, offset, and value into `R0`–`R3`, stores each into the drive's memory-mapped registers, and stores `CMD.WRITE` last to trigger the seek. It sends `loadProgram` → `addProcess` → `start`, then **blocks on the drive's completion interrupt** appearing in `interruptSources` before moving to the next byte, with a timeout of `(instructions + SEEK_TICKS + SLACK_TICKS) × CLOCK_MS + 500 ms`.

Waiting on the interrupt rather than a fixed delay is the point: it demonstrates interrupt-driven flow control and doubles as an end-to-end check across the WebSocket, scheduler, CPU, drive, and persistence layer. The default payload spells `Hello World!!!` across track 0, sector 0 — visible in the drive's panel, and still there after a server restart.

`SEEK_TICKS` is mirrored from `HardDrive.peripheral.ts`; update both together if the drive's timing changes.
