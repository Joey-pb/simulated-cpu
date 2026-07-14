"use client";

/**
 * @module SimulationProvider
 *
 * React context provider that owns the WebSocket connection to the CPU
 * simulation server (port 3006). Exposes real-time simulation state and
 * action callbacks via the {@link useSimulation} hook.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import type { CoreState, ProcessState } from "@/types/cpu.types";
import type { PeripheralSnapshot } from "@/types/peripheral.types";
import type { MemoryAccessEvent } from "@/types/memory.types";

// ─── State ──────────────────────────────────────────────────────────────────

/** Read-only simulation state derived from server broadcasts. */
interface SimulationState {
  connected: boolean;
  running: boolean;
  cycle: number;
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

// ─── Actions ────────────────────────────────────────────────────────────────

/**
 * Options for registering a peripheral. `peripheralType` must match a type
 * key in `peripherals/registry.ts`; any extra keys are that type's config
 * fields (e.g. `interval` for a timer).
 */
interface AddPeripheralOptions {
  peripheralType: string;
  id: string;
  name: string;
  handlerAddress: number;
  priority?: number;
  [configKey: string]: unknown;
}

/** Imperative actions sent as WS commands to the server. */
interface SimulationActions {
  start: () => void;
  stop: () => void;
  step: () => void;
  reset: () => void;
  addProcess: (
    name: string,
    programStart: number,
    programLength: number,
    priority?: number
  ) => void;
  setClockSpeed: (ms: number) => void;
  triggerPeripheral: (id: string) => void;
  loadProgram: (startAddress: number, bytes: number[]) => void;
  addPeripheral: (opts: AddPeripheralOptions) => void;
  removePeripheral: (id: string) => void;
  updatePeripheral: (id: string, updates: Record<string, unknown>) => void;
  setSchedulerType: (schedulerType: string) => void;
}

// ─── Context ────────────────────────────────────────────────────────────────

/** Combined context value: state + actions. */
type SimulationContextValue = SimulationState & SimulationActions;

/** React context holding the simulation value (null until provided). */
const SimulationContext = createContext<SimulationContextValue | null>(null);

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * Consume the simulation context.
 * @throws If called outside a `<SimulationProvider>`.
 */
export function useSimulation(): SimulationContextValue {
  const ctx = useContext(SimulationContext);
  if (!ctx) {
    throw new Error(
      "useSimulation must be used within a <SimulationProvider>"
    );
  }
  return ctx;
}

// ─── Default State ──────────────────────────────────────────────────────────

/** Sensible defaults before the first WS message arrives. */
const DEFAULT_STATE: SimulationState = {
  connected: false,
  running: false,
  cycle: 0,
  clockSpeed: 1000,
  schedulerType: "ROUND_ROBIN",
  coreStates: [],
  processQueue: [],
  peripherals: [],
  interruptsFired: 0,
  interruptSources: [],
  pendingInterrupts: 0,
  memorySlice: [],
  recentAccesses: [],
};

const WS_URL = "ws://localhost:3006";
const RECONNECT_DELAY = 2000;

// ─── Provider ───────────────────────────────────────────────────────────────

/**
 * Top-level provider that manages the WebSocket lifecycle and exposes
 * simulation state + action callbacks to all descendants.
 */
export function SimulationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SimulationState>(DEFAULT_STATE);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Send helper ──────────────────────────────────────────────────────

  const send = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  // ── WebSocket connection ─────────────────────────────────────────────

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setState((prev) => ({ ...prev, connected: true }));
      };

      ws.onclose = () => {
        setState((prev) => ({ ...prev, connected: false }));
        wsRef.current = null;

        // Auto-reconnect
        reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY);
      };

      ws.onerror = () => {
        // onclose will fire after onerror, triggering reconnect
        ws.close();
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string) as Record<
            string,
            unknown
          >;

          if (data.type === "error") {
            console.error("[Simulation WS]", data.message);
            // Still apply any state fields so running/cycle stay in sync
            setState((prev) => ({
              ...prev,
              running: (data.running as boolean) ?? prev.running,
              cycle: (data.cycle as number) ?? prev.cycle,
              clockSpeed: (data.clockSpeed as number) ?? prev.clockSpeed,
              schedulerType:
                (data.schedulerType as string) ?? prev.schedulerType,
              coreStates:
                (data.coreStates as CoreState[]) ?? prev.coreStates,
              processQueue:
                (data.processQueue as ProcessState[]) ?? prev.processQueue,
              peripherals:
                (data.peripherals as PeripheralSnapshot[]) ?? prev.peripherals,
              interruptsFired:
                (data.interruptsFired as number) ?? prev.interruptsFired,
              interruptSources:
                (data.interruptSources as string[]) ?? prev.interruptSources,
              pendingInterrupts:
                (data.pendingInterrupts as number) ?? prev.pendingInterrupts,
              memorySlice:
                (data.memorySlice as number[]) ?? prev.memorySlice,
              recentAccesses:
                (data.recentAccesses as MemoryAccessEvent[]) ??
                prev.recentAccesses,
            }));
            return;
          }

          setState((prev) => ({
            ...prev,
            running: (data.running as boolean) ?? prev.running,
            cycle: (data.cycle as number) ?? prev.cycle,
            clockSpeed: (data.clockSpeed as number) ?? prev.clockSpeed,
            schedulerType:
              (data.schedulerType as string) ?? prev.schedulerType,
            coreStates:
              (data.coreStates as CoreState[]) ?? prev.coreStates,
            processQueue:
              (data.processQueue as ProcessState[]) ?? prev.processQueue,
            peripherals:
              (data.peripherals as PeripheralSnapshot[]) ?? prev.peripherals,
            interruptsFired:
              (data.interruptsFired as number) ?? prev.interruptsFired,
            interruptSources:
              (data.interruptSources as string[]) ?? prev.interruptSources,
            pendingInterrupts:
              (data.pendingInterrupts as number) ?? prev.pendingInterrupts,
            memorySlice:
              (data.memorySlice as number[]) ?? prev.memorySlice,
            recentAccesses:
              (data.recentAccesses as MemoryAccessEvent[]) ??
              prev.recentAccesses,
          }));
        } catch {
          console.error("[Simulation WS] Failed to parse message");
        }
      };
    }

    connect();

    return () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
      wsRef.current?.close();
    };
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────

  const start = useCallback(() => send({ type: "start" }), [send]);
  const stop = useCallback(() => send({ type: "stop" }), [send]);
  const step = useCallback(() => send({ type: "step" }), [send]);
  const reset = useCallback(() => send({ type: "reset" }), [send]);

  const addProcess = useCallback(
    (
      name: string,
      programStart: number,
      programLength: number,
      priority?: number
    ) => {
      send({ type: "addProcess", name, programStart, programLength, priority });
    },
    [send]
  );

  const setClockSpeed = useCallback(
    (ms: number) => {
      send({ type: "setClockSpeed", ms });
    },
    [send]
  );

  const triggerPeripheral = useCallback(
    (id: string) => {
      send({ type: "triggerPeripheral", id });
    },
    [send]
  );

  const loadProgram = useCallback(
    (startAddress: number, bytes: number[]) => {
      send({ type: "loadProgram", startAddress, bytes });
    },
    [send]
  );

  const addPeripheral = useCallback(
    (opts: AddPeripheralOptions) => {
      send({ type: "registerPeripheral", ...opts });
    },
    [send]
  );

  const removePeripheral = useCallback(
    (id: string) => {
      send({ type: "removePeripheral", id });
    },
    [send]
  );

  const updatePeripheral = useCallback(
    (id: string, updates: Record<string, unknown>) => {
      send({ type: "updatePeripheral", id, updates });
    },
    [send]
  );

  const setSchedulerType = useCallback(
    (schedulerType: string) => {
      send({ type: "setSchedulerType", schedulerType });
    },
    [send]
  );

  // ── Memoised value ──────────────────────────────────────────────────

  const value = useMemo<SimulationContextValue>(
    () => ({
      ...state,
      start,
      stop,
      step,
      reset,
      addProcess,
      setClockSpeed,
      triggerPeripheral,
      loadProgram,
      addPeripheral,
      removePeripheral,
      updatePeripheral,
      setSchedulerType,
    }),
    [
      state,
      start,
      stop,
      step,
      reset,
      addProcess,
      setClockSpeed,
      triggerPeripheral,
      loadProgram,
      addPeripheral,
      removePeripheral,
      updatePeripheral,
      setSchedulerType,
    ]
  );

  return (
    <SimulationContext.Provider value={value}>
      {children}
    </SimulationContext.Provider>
  );
}
