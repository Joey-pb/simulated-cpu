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
import ButtonPeripheral from "@/peripherals/Button.peripheral";
import TimerPeripheral from "@/peripherals/Timer.peripheral";
import { SensorPeripheral } from "@/peripherals/Sensor.peripheral";
import { ProximitySensorPeripheral } from "@/peripherals/ProximitySensor.peripheral";
import { ScreenPeripheral } from "@/peripherals/Screen.peripheral";
import { PotentiometerPeripheral } from "@/peripherals/Potentiometer.peripheral";
import { LEDPeripheral } from "@/peripherals/LED.peripheral";
import type { ClockEvent, CoreState, ProcessState } from "@/types/cpu.types";
import type { PeripheralSnapshot, Peripheral } from "@/types/peripheral.types";
import type { MemoryAccessEvent } from "@/types/memory.types";
import { SevenSegmentDisplay } from "@/peripherals/SevenSegmentDisplay.peripheral";

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

// ─── ISR Programs ───────────────────────────────────────────────────────────

/**
 * Data region (within first 64 bytes so it's visible in the Memory hex grid):
 *   0x003C = constant 1 (used by ISRs for incrementing)
 *   0x003D = timer counter
 *   0x003E = sensor counter
 *   0x003F = button counter
 *
 * Each ISR: LOAD counter → LOAD const(1) → ADD → STORE counter → IRET
 */
const CONST_ONE_ADDR = 0x003C;
const DATA_ADDRS: Record<string, number> = {
  timer: 0x003D,
  sensor: 0x003E,
  button: 0x003F,
  proximity: 0x0039,
  potentiometer: 0x003B,
};

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
  const dataAddr = DATA_ADDRS[peripheralType];
  if (dataAddr === undefined) return; // unknown type — skip
  const isr = buildISR(dataAddr);
  memory.loadProgram(handlerAddress, isr);
  console.log(
    `[WS] Loaded ISR for ${peripheralType} at 0x${handlerAddress.toString(16).padStart(4, "0")} → counter at 0x${dataAddr.toString(16).padStart(4, "0")}`
  );
}

// ─── Peripheral Factory ─────────────────────────────────────────────────────

/**
 * Instantiate a peripheral from a raw WS message.
 * @throws If `peripheralType` is not one of button | timer | sensor.
 */
function createPeripheral(msg: IncomingMessage): Peripheral {
  const peripheralType = msg.peripheralType as string;
  const id = msg.id as string;
  const name = msg.name as string;
  const handlerAddress = msg.handlerAddress as number;
  const priority = (msg.priority as number) ?? 0;

  switch (peripheralType) {
    case "button":
      return new ButtonPeripheral(id, name, handlerAddress, priority);
    case "timer": {
      const interval = (msg.interval as number) ?? 10;
      return new TimerPeripheral(id, name, handlerAddress, interval, priority);
    }
    case "sensor": {
      const threshold = (msg.threshold as number) ?? 75;
      return new SensorPeripheral(id, name, handlerAddress, threshold, priority);
    }
    case "proximity": {
      const radius = (msg.radius as number) ?? 100;
      return new ProximitySensorPeripheral(
        id, name, handlerAddress, radius, priority, memory,
      );
    }
    case "screen": {
      const width = (msg.gridWidth as number) ?? 32;
      const height = (msg.gridHeight as number) ?? 8;
      const sourceAddress = (msg.sourceAddress as number) ?? 0x0038;
      return new ScreenPeripheral(
        id, name, handlerAddress, width, height, sourceAddress, memory,
      );
    }
    case "potentiometer": {
      const maxResistance = (msg.maxResistance as number) ?? 100;
      const registerAddress = (msg.registerAddress as number) ?? 0x003A;
      return new PotentiometerPeripheral(
        id,
        name,
        handlerAddress,
        maxResistance,
        priority,
        memory,
        registerAddress,
      );
    }
    case "led": {
      const color = (msg.color as string) ?? "#ef4444";
      const sourceAddress = (msg.sourceAddress as number) ?? 0x003A;
      const initialLevel = ((msg.initialLevel as string) ?? "LOW") === "HIGH" ? "HIGH" : "LOW";
      return new LEDPeripheral(
        id,
        name,
        0,
        color,
        memory,
        sourceAddress,
        initialLevel,
      );
    }
    case "seven-segment-display": {
      const interval = (msg.interval as number) ?? 8;
      return new SevenSegmentDisplay(id, name, handlerAddress, interval, memory);
    }
    default:
      throw new Error(`Unknown peripheral type: ${peripheralType}`);
  }
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

        if (peripheral instanceof TimerPeripheral) {
          if (typeof updates.interval === "number") {
            peripheral.setInterval(updates.interval);
          }
        } else if (peripheral instanceof SensorPeripheral) {
          if (typeof updates.threshold === "number") {
            peripheral.setThreshold(updates.threshold);
          }
          if (typeof updates.currentValue === "number") {
            peripheral.setValue(updates.currentValue);
          }
        } else if (peripheral instanceof ProximitySensorPeripheral) {
          if (typeof updates.currentDistance === "number") {
            peripheral.setDistance(updates.currentDistance);
          }
          if (typeof updates.radius === "number") {
            peripheral.setRadius(updates.radius);
          }
        } else if (peripheral instanceof ScreenPeripheral) {
          if (typeof updates.sourceAddress === "number") {
            peripheral.setSourceAddress(updates.sourceAddress);
          }
          if (typeof updates.tickDivider === "number") {
            peripheral.setTickDivider(updates.tickDivider);
          }
          if (updates.clear === true) {
            peripheral.clearScreen();
          }
        } else if (peripheral instanceof PotentiometerPeripheral) {
          if (typeof updates.maxResistance === "number") {
            peripheral.setMaxResistance(updates.maxResistance);
          }
          if (typeof updates.currentResistance === "number") {
            peripheral.setResistance(updates.currentResistance);
          }
        } else if (peripheral instanceof LEDPeripheral) {
          if (typeof updates.sourceAddress === "number") {
            peripheral.setSourceAddress(updates.sourceAddress);
          }
        }

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
