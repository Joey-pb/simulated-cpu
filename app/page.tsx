"use client";

/**
 * @module VisualizerPage
 *
 * Next.js page that renders the full React Flow canvas, wiring CPU,
 * Memory, and Peripheral nodes with animated edges. Peripheral nodes
 * are auto-positioned and edges animate during interrupts / memory access.
 */

import { useEffect, useRef } from "react";
import {
  ReactFlow,
  Background,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  SimulationProvider,
  useSimulation,
} from "@/app/_modules/SimulationProvider.module";
import { CPUNode } from "@/app/_components/CPUNode.component";
import { MemoryNode } from "@/app/_components/MemoryNode.component";
import { PeripheralNode } from "@/app/_components/PeripheralNode.component";
import { ProximityNode } from "@/app/_components/ProximityNode.component";
import { ScreenNode } from "@/app/_components/ScreenNode.component";
import { PotentiometerNode } from "@/app/_components/PotentiometerNode.component";
import { LEDNode } from "@/app/_components/LEDNode.component";
import { ControlsBar } from "@/app/_components/ControlsBar.component";
import { AddPeripheralPanel } from "@/app/_components/AddPeripheralPanel.component";
import { CoreTimeline } from "@/app/_components/CoreTimeline.component";
import SevenSegmenteDisplayNode from "./_components/SevenSegmentDisplay/SevenSegmenetDisplay.component";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Registered custom React Flow node types. */
const NODE_TYPES: NodeTypes = {
  cpu: CPUNode,
  memory: MemoryNode,
  peripheral: PeripheralNode,
  proximity: ProximityNode,
  screen: ScreenNode,
  potentiometer: PotentiometerNode,
  led: LEDNode,
  "seven-segment-display": SevenSegmenteDisplayNode
};

/** Horizontal spacing between peripheral nodes. */
const PERIPH_GAP = 220;
/** Vertical gap between peripheral row and CPU node. */
const PERIPH_CPU_GAP = 200;
/** Vertical gap between CPU and Memory. */
const CPU_MEM_GAP = 400;
/** Extra Y offset for screen nodes (below Memory). */
const SCREEN_Y_OFFSET = 200;

// ─── Layout Helpers ─────────────────────────────────────────────────────────

/** Centre N items of `width` each around x = cpuX. */
function spreadX(count: number, gap: number, centreX: number): number[] {
  if (count === 0) return [];
  const totalWidth = (count - 1) * gap;
  const startX = centreX - totalWidth / 2;
  return Array.from({ length: count }, (_, i) => startX + i * gap);
}

// ─── Static Nodes & Edges ───────────────────────────────────────────────────

/** Fixed X / Y for the CPU node. */
const CPU_X = 250;
const CPU_Y = 200;

/** Initial nodes: CPU + Memory (peripherals added dynamically). */
const INITIAL_NODES: Node[] = [
  {
    id: "cpu",
    type: "cpu",
    position: { x: CPU_X, y: CPU_Y },
    data: {},
    draggable: true,
  },
  {
    id: "memory",
    type: "memory",
    position: { x: CPU_X, y: CPU_Y + CPU_MEM_GAP },
    data: {},
    draggable: true,
  },
];

/** Static edge connecting CPU → Memory (data bus). */
const DATA_BUS_EDGE: Edge = {
  id: "cpu-memory",
  source: "cpu",
  target: "memory",
  label: "data bus",
  type: "smoothstep",
  style: { stroke: "#3b82f6", strokeWidth: 2.5 },
  animated: false,
};

// ─── Canvas ─────────────────────────────────────────────────────────────────

/**
 * Inner canvas that consumes simulation context to sync nodes/edges
 * with live peripheral and memory-access data.
 */
function VisualizerCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState([DATA_BUS_EDGE]);
  const { peripherals, recentAccesses, interruptSources } = useSimulation();

  /** Track which peripheral IDs we've already positioned so we don't
   *  override user-dragged positions on every tick. */
  const knownPeripheralIds = useRef(new Set<string>());

  // ── Sync peripheral nodes + all edges each tick ──────────────────────

  useEffect(() => {
    // Output peripherals are rendered below memory; input/control above CPU.
    const outputs = peripherals.filter(
      (p) => ["screen", "seven-segment-display", "led"].includes(p.meta.type as string),
    );
    const inputs = peripherals.filter(
      (p) => !["screen", "seven-segment-display", "led"].includes(p.meta.type as string),
    );

    // Layout input/control peripherals above CPU
    const nsCount = inputs.length;
    const nsXs = spreadX(nsCount, PERIPH_GAP, CPU_X);

    const upperNodes: Node[] = inputs.map((p, i) => {
      let nodeType = "peripheral";
      if (p.meta.type === "proximity") nodeType = "proximity";
      if (p.meta.type === "potentiometer") nodeType = "potentiometer";

      return {
        id: `peripheral-${p.id}`,
        type: nodeType as string,
        position: { x: nsXs[i], y: CPU_Y - PERIPH_CPU_GAP },
        data: { peripheral: p },
        draggable: true,
      };
    });

    // Layout output peripherals below Memory
    const scXs = spreadX(outputs.length, PERIPH_GAP + 40, CPU_X);
    const outputNodes: Node[] = outputs.map((p, i) => ({
      id: `peripheral-${p.id}`,
      type: p.meta.type as string,
      position: { x: scXs[i], y: CPU_Y + CPU_MEM_GAP + SCREEN_Y_OFFSET },
      data: { peripheral: p },
      draggable: true,
    }));

    const peripheralNodes: Node[] = [...upperNodes, ...outputNodes];

    const peripheralEdges: Edge[] = peripherals.map((p) => {
      const isScreen = p.meta.type === "screen";
      const isFiring = interruptSources.includes(p.id);

      if (isScreen || p.meta.type === "led") {
        // Output peripherals get a data-bus edge from CPU.
        return {
          id: `peripheral-${p.id}-cpu`,
          source: "cpu",
          target: `peripheral-${p.id}`,
          label: isScreen ? "display" : "output",
          type: "smoothstep",
          animated: p.status === "ACTIVE",
          style: {
            stroke: "#10b981",
            strokeWidth: 2,
          },
        };
      }

      return {
        id: `peripheral-${p.id}-cpu`,
        source: `peripheral-${p.id}`,
        target: "cpu",
        label: isFiring ? "⚡ IRQ" : "IRQ",
        type: "smoothstep",
        animated: p.status === "ACTIVE" || isFiring,
        style: {
          stroke: isFiring ? "#dc2626" : "#ef4444",
          strokeWidth: isFiring ? 3 : 1.5,
          strokeDasharray: isFiring ? undefined : "6 3",
        },
      };
    });

    // Animate data bus when there are recent memory accesses
    const busAnimated = recentAccesses.length > 0;

    setNodes((prev) => {
      const base = prev.filter((n) => !n.id.startsWith("peripheral-"));
      const merged = peripheralNodes.map((pn) => {
        // Keep dragged position for nodes we've seen before
        if (knownPeripheralIds.current.has(pn.id)) {
          const existing = prev.find((n) => n.id === pn.id);
          return existing
            ? { ...pn, position: existing.position }
            : pn;
        }
        knownPeripheralIds.current.add(pn.id);
        return pn;
      });
      return [...base, ...merged];
    });

    setEdges(() => {
      const bus: Edge = { ...DATA_BUS_EDGE, animated: busAnimated };
      return [bus, ...peripheralEdges];
    });

    // Clean up removed peripherals from the tracking set
    const currentIds = new Set(peripherals.map((p) => `peripheral-${p.id}`));
    for (const id of knownPeripheralIds.current) {
      if (!currentIds.has(id)) knownPeripheralIds.current.delete(id);
    }
  }, [peripherals, recentAccesses, setNodes, setEdges]);

  return (
    <div className="h-screen w-screen bg-white">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 0.85 }}
        className="bg-white"
      >
        <Background gap={16} size={1} color="#e4e4e7" />
        <Panel position="top-center">
          <ControlsBar />
        </Panel>
        <Panel position="top-right">
          <AddPeripheralPanel />
        </Panel>
        <Panel position="bottom-left">
          <CoreTimeline />
        </Panel>
        <MiniMap
          className="bg-white border border-zinc-200 rounded-lg"
          maskColor="rgba(0, 0, 0, 0.1)"
        />
      </ReactFlow>
    </div>
  );
}

/** Root page: wraps the canvas in the simulation provider. */
export default function VisualizerPage() {
  return (
    <SimulationProvider>
      <VisualizerCanvas />
    </SimulationProvider>
  );
}
