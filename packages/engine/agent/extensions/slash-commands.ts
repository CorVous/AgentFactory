// slash-commands.ts — in-peer extension: registers launcher slash commands.
//
// Currently registers:
//   /focus <peer>      — request the launcher to focus a specific peer.
//   /tail [filter]     — toggle the bus-tail overlay.
//   /pin               — pin the currently-open ctx.ui.confirm dialog into the launcher queue.
//   /decisions         — request the launcher to jump focus into the decisions-queue panel.
//
// The commands send typed envelopes to the launcher via the `launcher-bridge`.
// If the bridge is not connected (standalone mode), the commands print a warning.
//
// Loaded as part of the peer template (alongside launcher-bridge).
// Silent no-op when the launcher socket is absent.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHabitat } from "../lib/habitat.js";
import { getMeshRailHandle } from "../lib/mesh-rail.js";
import { createDecisionsOverlayComponent } from "../lib/decisions-overlay.js";
// IMPORTANT: this is a static jiti-resolved import, not createRequire().
// Node's createRequire cannot resolve .ts files, so any attempt to load the
// bridge dynamically (e.g. _require("./launcher-bridge")) silently throws and
// the slash commands fall back to "standalone mode". Pulling the helpers in
// statically lets jiti rewrite the path during transformation.
import { sendControl as bridgeSendControl } from "./launcher-bridge.js";

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the launcher-envelope module path relative to this extension file.
// The extension lives at packages/engine/agent/extensions/slash-commands.ts;
// the launcher-envelope lives at packages/engine/agent/lib/launcher-envelope.mjs.
function getLauncherEnvelopePath(): string {
  return path.resolve(__dirname, "../lib/launcher-envelope.mjs");
}

// Per-peer tail state, stashed on globalThis so it survives jiti module isolation.
interface TailState {
  on: boolean;
  filter: string | undefined;
}

function getTailState(): TailState {
  const g = globalThis as { __pi_slash_tail_state__?: TailState };
  return (g.__pi_slash_tail_state__ ??= { on: false, filter: undefined });
}

export default function (pi: ExtensionAPI) {
  // Register /focus <peer> as a slash command.
  // pi.registerCommand registers a command that is invoked when the user types
  // "/<name> <args>" in the interactive TUI.
  pi.registerCommand("focus", {
    description: "Switch launcher focus to another peer. Usage: /focus <peer-name>",
    handler: async (args: string, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("/focus requires a peer name: /focus <peer-name>", "warning");
        return;
      }

      const habitat = getHabitat();
      const agentName = habitat.instanceName;

      // bridgeSendControl is the launcher-bridge's exported send helper. It
      // returns false in standalone mode (no launcher socket), which we map to
      // a friendly warning further down.
      const sendControl = bridgeSendControl;

      // Build a focus-request envelope.
      let makeFocusRequestEnvelope: ((args: { from: string; target: string }) => Record<string, unknown>) | undefined;
      try {
        const envMod = _require(getLauncherEnvelopePath()) as {
          makeFocusRequestEnvelope: (args: { from: string; target: string }) => Record<string, unknown>;
        };
        makeFocusRequestEnvelope = envMod.makeFocusRequestEnvelope;
      } catch {
        ctx.ui.notify("/focus: launcher-envelope module not found.", "warning");
        return;
      }

      const env = makeFocusRequestEnvelope({ from: agentName, target });
      const sent = sendControl(env);

      if (sent) {
        ctx.ui.notify(`/focus: requested focus → ${target}`, "info");
      } else {
        ctx.ui.notify(
          `/focus: launcher not connected. Cannot switch focus to ${target}.`,
          "warning",
        );
      }
    },
  });

  // Register /tail [filter] as a slash command.
  // Toggles the launcher's bus-tail overlay. An optional filter restricts the
  // overlay to a specific envelope kind (e.g. "message", "submission").
  pi.registerCommand("tail", {
    description:
      "Toggle the launcher bus-tail overlay. Usage: /tail [filter] " +
      "(filter: message/messages, submission/submissions, approval-request, …)",
    handler: async (args: string, ctx) => {
      const filter = args.trim() || undefined;

      // bridgeSendControl is statically imported from launcher-bridge above.
      const sendControl = bridgeSendControl;

      // Build a tail-toggle envelope.
      let makeTailToggleEnvelope:
        | ((args: { on: boolean; filter?: string }) => Record<string, unknown>)
        | undefined;
      try {
        const envMod = _require(getLauncherEnvelopePath()) as {
          makeTailToggleEnvelope: (args: { on: boolean; filter?: string }) => Record<string, unknown>;
        };
        makeTailToggleEnvelope = envMod.makeTailToggleEnvelope;
      } catch {
        ctx.ui.notify("/tail: launcher-envelope module not found.", "warning");
        return;
      }

      const tailState = getTailState();
      const turningOn = !tailState.on;
      tailState.on = turningOn;
      tailState.filter = turningOn ? filter : undefined;

      const envArgs: { on: boolean; filter?: string } = { on: turningOn };
      if (turningOn && filter) envArgs.filter = filter;

      const env = makeTailToggleEnvelope(envArgs);
      const sent = sendControl(env);

      if (turningOn) {
        const filterNote = filter ? ` (filter: ${filter})` : "";
        ctx.ui.notify(
          sent
            ? `/tail: bus-tail overlay enabled${filterNote}.`
            : `/tail: launcher not connected; tail state updated locally.`,
          sent ? "info" : "warning",
        );
      } else {
        ctx.ui.notify(
          sent
            ? `/tail: bus-tail overlay disabled.`
            : `/tail: launcher not connected; tail state updated locally.`,
          sent ? "info" : "warning",
        );
      }
    },
  });

  // Register /pin as a slash command.
  // Promotes the currently-rendered ctx.ui.confirm dialog into the launcher's
  // persistent decisions queue (sticky lifecycle — survives focus changes).
  // Reads the current decision from intercept's __pi_current_decision__ globalThis slot.
  pi.registerCommand("pin", {
    description: "Pin the currently-open dialog into the launcher decisions queue (sticky lifecycle).",
    handler: async (args: string, ctx) => {
      // Read the current decision from the intercept extension's globalThis slot.
      const currentDecision = (
        globalThis as { __pi_current_decision__?: { msg_id: string; peer: string; kind: string; summary: string } | null }
      ).__pi_current_decision__;

      if (!currentDecision) {
        ctx.ui.notify("/pin: no dialog is currently open to pin.", "warning");
        return;
      }

      const sendControl = bridgeSendControl;

      // Build a pin-request envelope.
      let makePinRequestEnvelope: ((args: { msg_id: string; peer: string; kind: string; summary: string }) => Record<string, unknown>) | undefined;
      try {
        const envMod = _require(getLauncherEnvelopePath()) as {
          makePinRequestEnvelope: (args: { msg_id: string; peer: string; kind: string; summary: string }) => Record<string, unknown>;
        };
        makePinRequestEnvelope = envMod.makePinRequestEnvelope;
      } catch {
        ctx.ui.notify("/pin: launcher-envelope module not found.", "warning");
        return;
      }

      const env = makePinRequestEnvelope({
        msg_id: currentDecision.msg_id,
        peer: currentDecision.peer,
        kind: currentDecision.kind,
        summary: currentDecision.summary,
      });
      const sent = sendControl(env);

      if (sent) {
        ctx.ui.notify(`/pin: dialog pinned to decisions queue (msg_id=${currentDecision.msg_id.slice(0, 8)}).`, "info");
      } else {
        ctx.ui.notify("/pin: launcher not connected. Cannot pin dialog.", "warning");
      }
    },
  });

  // Register /decisions as a slash command.
  // Opens a focus-capturing centered overlay listing all peers and queued
  // decisions with arrow-key navigation. While the overlay is open, the
  // always-on mesh-rail widget is hidden to reclaim its layout slot; it
  // reappears on close.
  //
  // Falls back to emitting a decisions-jump envelope when ctx.hasUI is false
  // (i.e. RPC / print mode) so the launcher can still honour the request.
  pi.registerCommand("decisions", {
    description: "Open the decisions overlay (peers + decision queue with arrow-key navigation).",
    handler: async (args: string, ctx) => {
      if (!ctx.hasUI) {
        // No UI available — fall back to launcher notification via decisions-jump.
        const habitat = getHabitat();
        const agentName = habitat.instanceName;

        const sendControl = bridgeSendControl;

        let makeDecisionsJumpEnvelope: ((args: { from: string }) => Record<string, unknown>) | undefined;
        try {
          const envMod = _require(getLauncherEnvelopePath()) as {
            makeDecisionsJumpEnvelope: (args: { from: string }) => Record<string, unknown>;
          };
          makeDecisionsJumpEnvelope = envMod.makeDecisionsJumpEnvelope;
        } catch {
          ctx.ui.notify("/decisions: launcher-envelope module not found.", "warning");
          return;
        }

        const env = makeDecisionsJumpEnvelope({ from: agentName });
        const sent = sendControl(env);
        if (sent) {
          ctx.ui.notify("/decisions: requested focus → decisions-queue panel.", "info");
        } else {
          ctx.ui.notify("/decisions: launcher not connected.", "warning");
        }
        return;
      }

      // UI is available — open the rich overlay. The mesh-rail stays visible
      // throughout so the human keeps ambient peer-state context while picking
      // an action in the overlay.
      const railHandle = getMeshRailHandle();
      const state = railHandle?.getState() ?? { peers: [], decisions: [], decisionCount: 0, peerName: "" };

      const result = await ctx.ui.custom(
        (_tui, _theme, _keybindings, done) => {
          const overlay = createDecisionsOverlayComponent({
            peers: state.peers,
            decisions: state.decisions ?? [],
            done,
          });
          return overlay;
        },
        { overlay: true },
      );

      // If the user pressed Enter on a decision, emit a focus-request so the
      // launcher switches to that peer's pane. Best-effort: bridgeSendControl
      // returns false in standalone mode and the user has already gotten what
      // they wanted from the overlay.
      if (result && result.action === "focus-peer" && result.peer) {
        let makeFocusRequestEnvelope: ((args: { from: string; target: string }) => Record<string, unknown>) | undefined;
        try {
          const envMod = _require(getLauncherEnvelopePath()) as {
            makeFocusRequestEnvelope: (args: { from: string; target: string }) => Record<string, unknown>;
          };
          makeFocusRequestEnvelope = envMod.makeFocusRequestEnvelope;
        } catch {
          // ignore — launcher-envelope module not resolvable
        }

        if (makeFocusRequestEnvelope) {
          const habitat = getHabitat();
          bridgeSendControl(makeFocusRequestEnvelope({ from: habitat.instanceName, target: result.peer }));
        }
      }
    },
  });
}
