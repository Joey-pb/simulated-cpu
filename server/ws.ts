/**
 * @module WebSocketServer
 *
 * Standalone WebSocket server (port 3006) that owns a single {@link CPUService}
 * and {@link MemoryService} instance. Clients send JSON commands (start, stop,
 * step, reset, addProcess, registerPeripheral, etc.) and receive real-time
 * tick/state broadcasts as {@link BroadcastPayload} messages.
 */

import { WebSocketServer, WebSocket } from "ws";
import { MemoryService } from "@/services/Memory.service";
import { CPUService } from "@/services/cpu/CPU.service";
import { SchedulerType } from "@/types/cpu.types";
import { getDefinition, type PeripheralConfig } from "@/peripherals/registry";
import { HardDrive } from "@/peripherals/HardDrive.peripheral";
import { HDDPersistenceService } from "@/services/hdd/HDDPersistence.service";
import type { ClockEvent, CoreState, ProcessState } from "@/types/cpu.types";
import type { PeripheralSnapshot, Peripheral } from "@/types/peripheral.types";
import type { MemoryAccessEvent } from "@/types/memory.types";

// ─── WS Message Types ───────────────────────────────────────────────────────

/** Incoming JSON command from a connected client. */
interface IncomingMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Payload broadcast to all connected clients on each tick or state change.
 * Contains the complete simulation snapshot.
 */
interface BroadcastPayload {
  type: "tick" | "state" | "error";
  cycle: number;
  running: boolean;
  clockSpeed: number;
  schedulerType: string;
  coreStates: CoreState[];
  processQueue: ProcessState[];
  peripherals: PeripheralSnapshot[];
  interruptsFired: number;
  interruptSources: string[];
  pendingInterrupts: number;
  memorySlice: number[];
  recentAccesses: MemoryAccessEvent[];
}

// ─── Create CPU + Memory ────────────────────────────────────────────────────

const memory = new MemoryService();
const cpu = new CPUService(memory);

// ─── HDD Persistence ───────────────────────────────────────────────────────────
// Where the hard-drive's backing image lives on disk.
const DISK_IMAGE_PATH = "./app/data/disk.img";

// ─── ISR Programs ───────────────────────────────────────────────────────────

/**
 * Data region (within first 64 bytes so it's visible in the Memory hex grid):
 *   0x003C = constant 1 (used by ISRs for incrementing)
 *
 * Each peripheral type's counter address comes from its `dataAddress` in
 * `peripherals/registry.ts`.
 *
 * Each ISR: LOAD counter → LOAD const(1) → ADD → STORE counter → IRET
 */
const CONST_ONE_ADDR = 0x003C;

/** Build a 20-byte ISR that increments the counter at `dataAddr`. */
function buildISR(dataAddr: number): number[] {
  return [
    0x01, 0x00, (dataAddr >> 8) & 0xFF, dataAddr & 0xFF,             // LOAD R0, dataAddr
    0x01, 0x01, (CONST_ONE_ADDR >> 8) & 0xFF, CONST_ONE_ADDR & 0xFF, // LOAD R1, CONST_ONE_ADDR
    0x03, 0x00, 0x01, 0x00,                                          // ADD  R0, R1
    0x02, 0x00, (dataAddr >> 8) & 0xFF, dataAddr & 0xFF,             // STORE R0, dataAddr
    0xFE, 0x00, 0x00, 0x00,                                          // IRET
  ];
}

/** Ensure the constant-1 byte is in memory (idempotent). */
function ensureConstant() {
  if (memory.read(CONST_ONE_ADDR) !== 1) {
    memory.write(CONST_ONE_ADDR, 1);
  }
}

/** Load an ISR for a peripheral type at its handler address. */
function loadISRForPeripheral(peripheralType: string, handlerAddress: number) {
  ensureConstant();
  const dataAddr = getDefinition(peripheralType)?.dataAddress;
  if (dataAddr === undefined) return; // no ISR counter for this type — skip
  const isr = buildISR(dataAddr);
  memory.loadProgram(handlerAddress, isr);
  console.log(
    `[WS] Loaded ISR for ${peripheralType} at 0x${handlerAddress.toString(16).padStart(4, "0")} → counter at 0x${dataAddr.toString(16).padStart(4, "0")}`
  );
}

// ─── Peripheral Factory ─────────────────────────────────────────────────────

/**
 * Instantiate a peripheral from a raw WS message using its registry entry.
 * @throws If `peripheralType` is not in `peripherals/registry.ts`.
 */
function createPeripheral(msg: IncomingMessage): Peripheral {
  const peripheralType = msg.peripheralType as string;
  const definition = getDefinition(peripheralType);
  if (!definition) {
    throw new Error(
      `Unknown peripheral type: ${peripheralType} — is it registered in peripherals/registry.ts?`,
    );
  }

  const config: PeripheralConfig = {
    ...msg,
    id: msg.id as string,
    name: msg.name as string,
    handlerAddress: (msg.handlerAddress as number) ?? 0,
    priority: (msg.priority as number) ?? definition.defaultPriority ?? 0,
  };

  const peripheral = definition.create(config, memory);

  // Hard drives are the only peripheral type with persistence. The drive
  // itself has no filesystem knowledge (see HardDrive.peripheral.ts) — it
  // just exposes `storage` and `setPersistenceHandler`, which we wire up
  // here to an HDDPersistenceService for this specific instance.
  if (peripheralType === "hard-drive") {
    const drive = peripheral as HardDrive;
    // Constructing this loads any existing image into drive.storage
    // in place, seeding the drive with previously saved contents.
    const persistence = new HDDPersistenceService(
      DISK_IMAGE_PATH,
      drive.storage,
    );
    // Fired after every WRITE — see writeToDisk() in HardDrive.peripheral.ts.
    drive.setPersistenceHandler((storage, changedIndex) =>
      persistence.persistData(changedIndex),
    );
  }

  return peripheral;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Construct a {@link BroadcastPayload} from the current CPU state.
 * If a {@link ClockEvent} is provided the snapshot uses event data;
 * otherwise it polls the CPU directly.
 */
function buildPayload(
  type: "tick" | "state",
  event?: ClockEvent
): BroadcastPayload {
  const memoryBuffer = memory.getRawBuffer();
  const memorySlice = Array.from(memoryBuffer.slice(0, 64));
  const recentAccesses = memory.getRecentAccesses(5);

  if (event) {
    return {
      type,
      cycle: event.cycle,
      running: cpu.isRunning(),
      clockSpeed: cpu.getClockSpeed(),
      schedulerType: cpu.getSchedulerType(),
      coreStates: event.coreStates,
      processQueue: event.processQueue,
      peripherals: cpu.getPeripheralManager().toJSON(),
      interruptsFired: event.interruptsFired,
      interruptSources: event.interruptSources,
      pendingInterrupts: event.pendingInterrupts,
      memorySlice,
      recentAccesses,
    };
  }

  return {
    type,
    cycle: cpu.getCycle(),
    running: cpu.isRunning(),
    clockSpeed: cpu.getClockSpeed(),
    schedulerType: cpu.getSchedulerType(),
    coreStates: cpu.getCoreStates(),
    processQueue: cpu.getProcessQueue(),
    peripherals: cpu.getPeripheralManager().toJSON(),
    interruptsFired: 0,
    interruptSources: [],
    pendingInterrupts: 0,
    memorySlice,
    recentAccesses,
  };
}

/** Send a payload to every connected client. */
function broadcast(payload: BroadcastPayload): void {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/** Send a payload to a single client (if the socket is still open). */
function sendTo(ws: WebSocket, payload: BroadcastPayload | { type: "error"; message: string }): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ─── CPU Tick Listener ──────────────────────────────────────────────────────

cpu.onTick((event: ClockEvent) => {
  try {
    broadcast(buildPayload("tick", event));
  } catch (err) {
    cpu.stop();
    const errorPayload: BroadcastPayload = {
      ...buildPayload("state"),
      type: "error",
    };
    broadcast(errorPayload);
    console.error(`[WS] Tick error — CPU stopped:`, (err as Error).message);
  }
});

// ─── Command Handlers ───────────────────────────────────────────────────────

/**
 * Route a raw JSON string from a client to the appropriate CPU command.
 * Unknown commands receive an error response.
 */
function handleMessage(ws: WebSocket, raw: string): void {
  let msg: IncomingMessage;
  try {
    msg = JSON.parse(raw) as IncomingMessage;
  } catch {
    sendTo(ws, { type: "error", message: "Invalid JSON" });
    return;
  }

  switch (msg.type) {
    case "start": {
      try {
        cpu.start();
        broadcast(buildPayload("state"));
      } catch (err) {
        cpu.stop();
        broadcast(buildPayload("state"));
        sendTo(ws, { type: "error", message: (err as Error).message });
      }
      break;
    }

    case "stop": {
      cpu.stop();
      broadcast(buildPayload("state"));
      break;
    }

    case "step": {
      try {
        const event = cpu.step();
        broadcast(buildPayload("tick", event));
      } catch (err) {
        cpu.stop();
        broadcast(buildPayload("state"));
        sendTo(ws, { type: "error", message: (err as Error).message });
      }
      break;
    }

    case "reset": {
      cpu.reset();
      memory.reset();
      broadcast(buildPayload("state"));
      break;
    }

    case "addProcess": {
      const name = msg.name as string;
      const programStart = msg.programStart as number;
      const programLength = msg.programLength as number;
      const priority = msg.priority as number | undefined;
      try {
        const pid = cpu.addProcess(name, programStart, programLength, priority);
        sendTo(ws, { ...buildPayload("state"), type: "state" });
        console.log(`[WS] Added process "${name}" (PID ${pid})`);
      } catch (err) {
        sendTo(ws, { type: "error", message: (err as Error).message });
      }
      break;
    }

    case "setClockSpeed": {
      const ms = msg.ms as number;
      try {
        cpu.setClockSpeed(ms);
        broadcast(buildPayload("state"));
        console.log(`[WS] Clock speed set to ${ms}ms`);
      } catch (err) {
        sendTo(ws, { type: "error", message: (err as Error).message });
      }
      break;
    }

    case "triggerPeripheral": {
      const id = msg.id as string;
      try {
        cpu.triggerPeripheral(id);
        console.log(`[WS] Triggered peripheral "${id}"`);
      } catch (err) {
        sendTo(ws, { type: "error", message: (err as Error).message });
      }
      break;
    }

    case "loadProgram": {
      const startAddress = msg.startAddress as number;
      const bytes = msg.bytes as number[];
      try {
        memory.loadProgram(startAddress, bytes);
        broadcast(buildPayload("state"));
        console.log(`[WS] Loaded ${bytes.length} bytes at 0x${startAddress.toString(16).padStart(4, "0")}`);
      } catch (err) {
        sendTo(ws, { type: "error", message: (err as Error).message });
      }
      break;
    }

    case "registerPeripheral": {
      try {
        const peripheral = createPeripheral(msg);
        cpu.registerPeripheral(peripheral);
        cpu.connectPeripheral(peripheral.id);
        loadISRForPeripheral(msg.peripheralType as string, peripheral.toJSON().handlerAddress);
        broadcast(buildPayload("state"));
        console.log(`[WS] Registered peripheral "${peripheral.name}" (${peripheral.id})`);
      } catch (err) {
        sendTo(ws, { type: "error", message: (err as Error).message });
      }
      break;
    }

    case "removePeripheral": {
      const id = msg.id as string;
      try {
        cpu.unregisterPeripheral(id);
        broadcast(buildPayload("state"));
        console.log(`[WS] Removed peripheral "${id}"`);
      } catch (err) {
        sendTo(ws, { type: "error", message: (err as Error).message });
      }
      break;
    }

    case "updatePeripheral": {
      const id = msg.id as string;
      const updates = msg.updates as Record<string, unknown>;
      try {
        const peripheral = cpu.getPeripheralManager().get(id);
        if (!peripheral) throw new Error(`Peripheral "${id}" not found`);

        const definition = getDefinition(peripheral.toJSON().meta.type as string);
        definition?.applyUpdates?.(peripheral, updates);

        broadcast(buildPayload("state"));
        console.log(`[WS] Updated peripheral "${id}"`, updates);
      } catch (err) {
        sendTo(ws, { type: "error", message: (err as Error).message });
      }
      break;
    }

    case "setSchedulerType": {
      const schedulerType = msg.schedulerType as string;
      try {
        if (!Object.values(SchedulerType).includes(schedulerType as SchedulerType)) {
          throw new Error(`Invalid scheduler type: ${schedulerType}`);
        }
        cpu.setSchedulerType(schedulerType as SchedulerType);
        broadcast(buildPayload("state"));
        console.log(`[WS] Scheduler type set to ${schedulerType}`);
      } catch (err) {
        sendTo(ws, { type: "error", message: (err as Error).message });
      }
      break;
    }

    default: {
      sendTo(ws, { type: "error", message: `Unknown command: ${msg.type}` });
    }
  }
}

// ─── Start Server ───────────────────────────────────────────────────────────

const PORT = 3006;
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws: WebSocket) => {
  console.log(`[WS] Client connected (total: ${wss.clients.size})`);

  // Send current state on connect
  sendTo(ws, buildPayload("state"));

  ws.on("message", (data: Buffer) => {
    handleMessage(ws, data.toString());
  });

  ws.on("close", () => {
    console.log(`[WS] Client disconnected (total: ${wss.clients.size})`);
  });
});

console.log(`[WS] Simulation server running on ws://localhost:${PORT}`);
