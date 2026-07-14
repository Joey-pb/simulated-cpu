# Server

The WebSocket server that bridges the simulation backend to the frontend visualizer.

## Overview

`ws.ts` is a standalone Node.js server running on **port 3006**. It:

1. Creates a single `CPUService` and `MemoryService` instance (shared across all browser clients)
2. Listens for JSON commands from the frontend (start, stop, step, add peripheral, etc.)
3. Broadcasts the full simulation state to all connected clients on every tick

## Running

```bash
npm run ws        # Start the WebSocket server only
npm run dev:all   # Start both the WS server and the Next.js frontend
```

## Protocol

### Commands (Browser → Server)

Send a JSON message with a `type` field:

```json
{ "type": "start" }
{ "type": "stop" }
{ "type": "step" }
{ "type": "reset" }
{ "type": "setClockSpeed", "ms": 500 }
{ "type": "registerPeripheral", "peripheralType": "button", "id": "btn-1", "name": "My Button", "handlerAddress": 256 }
{ "type": "triggerPeripheral", "id": "btn-1" }
```

### Broadcasts (Server → All Browsers)

Every tick, the server sends a full state snapshot including: core states, process queue, peripheral snapshots, interrupt activity, and the first 64 bytes of memory.

## Peripheral Factory

When the frontend sends a `registerPeripheral` command, the server's `createPeripheral()` function looks up the `peripheralType` in `peripherals/registry.ts` and calls that entry's `create()` factory. If you create a new peripheral, you register it there — this file never needs to change (see `peripherals/README.md` for instructions).
