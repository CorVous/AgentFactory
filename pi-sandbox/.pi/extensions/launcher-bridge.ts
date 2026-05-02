// launcher-bridge.ts — in-peer extension: client side of the launcher socket.
//
// Connects to `${BUS_ROOT}/__launcher__.sock` at session_start. When the
// socket is missing (standalone `npm run pi` invocation), the extension
// degrades gracefully: no error, no tools registered.
//
// Provides:
//   - sendControl(env): send a LauncherEnvelope to the launcher.
//   - onSignal(handler): subscribe to signal envelopes from the launcher.
//
// When the launcher broadcasts a `focus-changed` envelope, the bridge
// updates the in-peer FocusState so the peer knows whether it is on-screen.
//
// Auto-loaded by run-agent.mjs when PI_MESH_PEER=1 or --launcher-sock is set.
// Silent no-op when the socket is absent.

import path from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getHabitat } from "./_lib/habitat";
import { createFocusState } from "./_lib/focus-state.mjs";

const _require = createRequire(import.meta.url);

// Stash on globalThis so other extensions can reach the bridge API after
// the extension is loaded (jiti module isolation pattern).
interface BridgeState {
  client: any | null;
  focusState: ReturnType<typeof createFocusState>;
  ready: boolean;
  signalHandlers: Array<(env: any) => void>;
  meshRailUpdateHandlers: Array<(env: any) => void>;
  // Cache of the most recent mesh-rail-update envelope so a handler that
  // subscribes after the launcher has already broadcast can replay the latest
  // snapshot immediately. Without this, the launcher's `client-connected →
  // broadcastRailUpdate` round-trip races with mesh-rail's `session_start`
  // (extensions session_start runs sequentially in load order — launcher-bridge
  // first, mesh-rail last — so the envelope can land in the empty handler
  // list and be lost).
  lastMeshRailUpdate: any | null;
}

function getBridgeState(): BridgeState {
  const g = globalThis as { __pi_launcher_bridge__?: BridgeState };
  return (g.__pi_launcher_bridge__ ??= {
    client: null,
    focusState: createFocusState(),
    ready: false,
    signalHandlers: [],
    meshRailUpdateHandlers: [],
    lastMeshRailUpdate: null,
  });
}

/**
 * Send a control envelope to the launcher.
 * No-op if not connected (standalone mode).
 */
export function sendControl(env: Record<string, unknown>): boolean {
  const state = getBridgeState();
  if (!state.ready || !state.client) return false;
  return state.client.send(env);
}

/**
 * Subscribe to signal envelopes from the launcher.
 */
export function onSignal(handler: (env: any) => void): void {
  const state = getBridgeState();
  state.signalHandlers.push(handler);
}

/**
 * Subscribe to mesh-rail-update envelopes from the launcher.
 * The handler receives the full envelope (peers array + decisionCount).
 * If the launcher has already broadcast a snapshot before this subscription
 * landed, the cached envelope is replayed synchronously so the late
 * subscriber doesn't start out with an empty view.
 */
export function onMeshRailUpdate(handler: (env: any) => void): void {
  const state = getBridgeState();
  state.meshRailUpdateHandlers.push(handler);
  if (state.lastMeshRailUpdate) {
    try { handler(state.lastMeshRailUpdate); } catch { /* ignore handler errors */ }
  }
}

/**
 * Get the current FocusState for this peer.
 */
export function getFocusState(): ReturnType<typeof createFocusState> {
  return getBridgeState().focusState;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const habitat = getHabitat();
    const busRoot = habitat.busRoot;
    const agentName = habitat.agentName;

    if (!busRoot) {
      // No bus root configured — standalone mode, skip silently.
      return;
    }

    const state = getBridgeState();
    state.focusState = createFocusState();

    // Lazy-import the launcher socket client from the scripts/_lib dir.
    // We use createRequire so we can load the .mjs file from TS extension.
    let createLauncherClient: (opts?: any) => any;
    try {
      // The path is relative to this extension file's location in the repo.
      const sockMod = _require(
        path.resolve(__dirname, "../../../scripts/_lib/launcher-socket.mjs"),
      );
      createLauncherClient = sockMod.createLauncherClient;
    } catch (e) {
      // launcher-socket module not present (e.g. during standalone pi usage).
      return;
    }

    const client = createLauncherClient();
    state.client = client;

    // Subscribe to launcher broadcasts before connecting.
    client.on("envelope", (env: any) => {
      if (!env || typeof env.kind !== "string") return;
      switch (env.kind) {
        case "focus-changed": {
          const focused = env.focused ?? null;
          state.focusState.update(focused === agentName);
          break;
        }
        case "signal": {
          for (const handler of state.signalHandlers) {
            try { handler(env); } catch { /* ignore handler errors */ }
          }
          break;
        }
        case "mesh-rail-update": {
          // Cache the latest snapshot so subscribers that register after this
          // arrival get replayed on subscribe (handles the launcher's
          // client-connected catch-up vs. mesh-rail session_start race).
          state.lastMeshRailUpdate = env;
          for (const handler of state.meshRailUpdateHandlers) {
            try { handler(env); } catch { /* ignore handler errors */ }
          }
          break;
        }
        default:
          break;
      }
    });

    client.on("disconnected", () => {
      state.ready = false;
      state.client = null;
    });

    try {
      await client.connect(busRoot, 1000);
      state.ready = true;
      if (process.env.AGENT_DEBUG === "1") {
        ctx.ui.notify("launcher-bridge: connected to launcher socket", "info");
      }
    } catch {
      // Launcher socket not present — standalone mode. Degrade gracefully.
      state.client = null;
      if (process.env.AGENT_DEBUG === "1") {
        ctx.ui.notify("launcher-bridge: launcher socket not found (standalone mode)", "info");
      }
    }
  });

  pi.on("session_end", async () => {
    const state = getBridgeState();
    if (state.client) {
      try { state.client.disconnect(); } catch { /* ignore */ }
      state.client = null;
      state.ready = false;
    }
  });
}
