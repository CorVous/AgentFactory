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
// Auto-loaded as part of the peer template (pi-sandbox/templates/peer.yaml).
// Silent no-op when the socket is absent.
//
// LAZY ACQUISITION: launcher socket connection is gated on habitatHasPeers().
// A solo run (no peers) skips the connect call entirely. Tools/exports still
// available so extension dependency order is unaffected.

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHabitat, tryGetHabitat } from "../lib/habitat.js";
import { createFocusState } from "../lib/focus-state.mjs";
import { habitatHasPeers } from "../lib/mesh-peering.js";

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stash on globalThis so other extensions can reach the bridge API after
// the extension is loaded (jiti module isolation pattern).
interface PendingSpawn {
  resolve: (result: { ok: boolean; name?: string; error?: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

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
  // Pending spawn-request correlations keyed by spawn-request msg_id.
  pendingSpawns: Map<string, PendingSpawn>;
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
    pendingSpawns: new Map(),
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

/**
 * Send a spawn-request envelope to the host launcher socket and await the
 * matching spawn-result reply.
 *
 * Resolves with `{ ok, name?, error? }` on a `spawn-result` whose
 * `in_reply_to` matches the request's `msg_id`.
 *
 * Rejects on timeout (default 5 minutes) or if not connected.
 *
 * @param env         The spawn-request envelope to send.
 * @param timeoutMs   Optional timeout in ms (default 5 min).
 */
export function requestSpawn(
  env: Record<string, unknown>,
  timeoutMs = 5 * 60_000,
): Promise<{ ok: boolean; name?: string; error?: string }> {
  const state = getBridgeState();
  if (!state.ready || !state.client) {
    return Promise.reject(new Error("requestSpawn: launcher-bridge not connected"));
  }

  const msgId = env.msg_id as string;
  if (!msgId) {
    return Promise.reject(new Error("requestSpawn: env.msg_id is required"));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingSpawns.delete(msgId);
      reject(new Error(`requestSpawn: timed out after ${timeoutMs}ms waiting for spawn-result`));
    }, timeoutMs);

    state.pendingSpawns.set(msgId, { resolve, reject, timer });
    state.client.send(env);
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const habitat = tryGetHabitat();
    if (!habitat) return;
    const busRoot = habitat.busRoot;
    const agentName = habitat.instanceName;

    if (!busRoot) {
      // No bus root configured — standalone mode, skip silently.
      return;
    }

    // LAZY ACQUISITION: skip launcher connect for solo runs (no peers configured).
    if (!habitatHasPeers(habitat)) {
      return;
    }

    const state = getBridgeState();
    state.focusState = createFocusState();

    // Lazy-import the launcher socket client from the engine lib dir.
    // We use createRequire so we can load the .mjs file from TS extension.
    let createLauncherClient: (opts?: any) => any;
    try {
      const sockMod = _require(
        path.resolve(__dirname, "../lib/launcher-socket.mjs"),
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
        case "spawn-result": {
          // Route to the pending spawn correlation map.
          const inReplyTo = env.in_reply_to as string | undefined;
          if (inReplyTo) {
            const pending = state.pendingSpawns.get(inReplyTo);
            if (pending) {
              clearTimeout(pending.timer);
              state.pendingSpawns.delete(inReplyTo);
              pending.resolve({
                ok: Boolean(env.ok),
                name: env.name as string | undefined,
                error: env.error as string | undefined,
              });
            }
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
      if (getHabitat().debug === true) {
        ctx.ui.notify("launcher-bridge: connected to launcher socket", "info");
      }
    } catch {
      // Launcher socket not present — standalone mode. Degrade gracefully.
      state.client = null;
      try {
        if (getHabitat().debug === true) {
          ctx.ui.notify("launcher-bridge: launcher socket not found (standalone mode)", "info");
        }
      } catch { /* Habitat not available */ }
    }
  });

  pi.on("session_shutdown", async () => {
    const state = getBridgeState();
    if (state.client) {
      try { state.client.disconnect(); } catch { /* ignore */ }
      state.client = null;
      state.ready = false;
    }
  });
}
