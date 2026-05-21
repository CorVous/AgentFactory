// bus-tail-emitter.ts — in-peer extension: forwards bus envelopes to the
// launcher's bus-tail overlay.
//
// Activates only when BOTH conditions are true:
//   1. This peer is the currently focused peer (getFocusState().isFocused() === true).
//   2. A `tail-on` signal has been received from the launcher via `tail-toggle`.
//
// Deactivates when either condition flips to false:
//   - Focus lost (focus-changed event from launcher-bridge).
//   - `tail-toggle { on: false }` received from launcher.
//
// When active, registers a `__pi_bus_tail_observe__` hook on globalThis so
// peer-bus.ts notifies it of every inbound/outbound envelope. Each envelope
// is forwarded to the launcher as a `tail-event` via the launcher-bridge's
// sendControl.
//
// Loaded as part of the peer template (alongside launcher-bridge).
// Silent no-op when the launcher socket is absent (launcher-bridge not ready).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stash state on globalThis (jiti module isolation pattern).
interface BusTailEmitterState {
  focused: boolean;
  tailOn: boolean;
  filter: string | undefined;
}

function getEmitterState(): BusTailEmitterState {
  const g = globalThis as { __pi_bus_tail_emitter__?: BusTailEmitterState };
  return (g.__pi_bus_tail_emitter__ ??= {
    focused: false,
    tailOn: false,
    filter: undefined,
  });
}

/**
 * Whether the emitter is currently active (both focused and tail-on).
 */
function isActive(state: BusTailEmitterState): boolean {
  return state.focused && state.tailOn;
}

/**
 * Update the __pi_bus_tail_observe__ hook based on current state.
 * Registers/deregisters the observer on globalThis depending on active status.
 */
function syncObserver(state: BusTailEmitterState) {
  const g = globalThis as { __pi_bus_tail_observe__?: (env: any, direction: "in" | "out") => void };
  if (!isActive(state)) {
    // Remove observer when not active.
    delete g.__pi_bus_tail_observe__;
    return;
  }

  // Register observer: forward each envelope to the launcher.
  g.__pi_bus_tail_observe__ = (env: any, _direction: "in" | "out") => {
    // Load bridge sendControl lazily (avoids circular import).
    let sendControl: ((env: Record<string, unknown>) => boolean) | undefined;
    try {
      const bridge = _require(path.resolve(__dirname, "launcher-bridge")) as {
        sendControl?: (env: Record<string, unknown>) => boolean;
      };
      sendControl = bridge.sendControl;
    } catch { /* bridge not loaded */ }

    if (!sendControl) return;

    // Load the launcher-envelope factory lazily.
    let makeTailEventEnvelope: ((args: any) => Record<string, unknown>) | undefined;
    try {
      const envMod = _require(
        path.resolve(__dirname, "../lib/launcher-envelope.mjs"),
      ) as { makeTailEventEnvelope?: (args: any) => Record<string, unknown> };
      makeTailEventEnvelope = envMod.makeTailEventEnvelope;
    } catch { /* module not available */ }

    if (!makeTailEventEnvelope) return;

    // Build body summary from the payload.
    let envKind = "unknown";
    let body = "";
    try {
      envKind = typeof env.payload?.kind === "string" ? env.payload.kind : "unknown";
      if (env.payload?.kind === "message") {
        body = String(env.payload.text ?? "").slice(0, 80);
      } else if (env.payload?.kind === "submission") {
        const count = Array.isArray(env.payload.artifacts) ? env.payload.artifacts.length : 0;
        body = `${count} artifact(s)`;
      } else if (env.payload?.kind === "approval-request") {
        body = String(env.payload.title ?? "").slice(0, 80);
      } else if (env.payload?.kind === "approval-result") {
        body = env.payload.approved ? "approved" : `rejected: ${env.payload.note ?? ""}`;
      } else if (env.payload?.kind === "revision-requested") {
        body = String(env.payload.note ?? "").slice(0, 80);
      }
    } catch { /* ignore payload read errors */ }

    // Apply filter: only emit if filter matches or no filter set.
    const currentFilter = getEmitterState().filter;
    if (currentFilter && envKind !== currentFilter) {
      // Normalise filter aliases before comparing.
      const normalised =
        currentFilter === "submissions" ? "submission" :
        currentFilter === "messages" ? "message" :
        currentFilter;
      if (envKind !== normalised) return;
    }

    // Get the peer name from launcher-bridge's habitat.
    let peerName = "unknown";
    try {
      const { getHabitat } = _require(path.resolve(__dirname, "../lib/habitat")) as {
        getHabitat?: () => { instanceName: string };
      };
      if (getHabitat) peerName = getHabitat().instanceName;
    } catch { /* ignore */ }

    const tailEnv = makeTailEventEnvelope({
      from: peerName,
      sender: typeof env.from === "string" ? env.from : "?",
      recipient: typeof env.to === "string" ? env.to : "?",
      envKind,
      body,
    });

    try { sendControl(tailEnv); } catch { /* ignore send errors */ }
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    const state = getEmitterState();
    state.focused = false;
    state.tailOn = false;
    state.filter = undefined;
    syncObserver(state);

    // Subscribe to focus-changed and tail-toggle signals from the launcher-bridge.
    // launcher-bridge exposes getFocusState() and onSignal() via globalThis stash.
    let getFocusState: (() => any) | undefined;
    let onSignal: ((handler: (env: any) => void) => void) | undefined;

    try {
      const bridge = _require(path.resolve(__dirname, "launcher-bridge")) as {
        getFocusState?: () => any;
        onSignal?: (handler: (env: any) => void) => void;
      };
      getFocusState = bridge.getFocusState;
      onSignal = bridge.onSignal;
    } catch { /* bridge not loaded — standalone mode */ }

    if (getFocusState) {
      const focusState = getFocusState();
      // Set initial focused state.
      state.focused = focusState.isFocused();
      syncObserver(state);

      // Subscribe to future focus changes.
      focusState.on("focus-changed", ({ focused }: { focused: boolean }) => {
        state.focused = focused;
        syncObserver(state);
      });
    }

    if (onSignal) {
      // Listen for tail-toggle signals from the launcher.
      onSignal((env: any) => {
        if (!env || typeof env.kind !== "string") return;
        if (env.kind === "tail-toggle") {
          const on = Boolean(env.on);
          state.tailOn = on;
          if (!on) {
            state.filter = undefined;
          } else if (typeof env.filter === "string" && env.filter.trim()) {
            state.filter = env.filter.trim();
          } else {
            state.filter = undefined;
          }
          syncObserver(state);

          try {
            const { getHabitat: _getHabitat } = _require(path.resolve(__dirname, "../lib/habitat")) as { getHabitat: () => { debug: boolean } };
            if (_getHabitat().debug === true) {
              process.stderr.write(
                `[bus-tail-emitter] tail-toggle: on=${on} filter=${state.filter ?? "none"}\n`,
              );
            }
          } catch { /* Habitat not available */ }
        }
      });
    }
  });

  pi.on("session_end", async () => {
    const state = getEmitterState();
    state.focused = false;
    state.tailOn = false;
    syncObserver(state);
  });
}
