// slash-commands.ts — in-peer extension: registers launcher slash commands.
//
// Currently registers:
//   /focus <peer>  — request the launcher to focus a specific peer.
//
// The command sends a `focus-request` envelope to the launcher via the
// `launcher-bridge`. If the bridge is not connected (standalone mode),
// the command prints a warning.
//
// Auto-loaded by run-agent.mjs when MESH_PEER=1 or alongside launcher-bridge.
// Silent no-op when the launcher socket is absent.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createRequire } from "node:module";
import path from "node:path";
import { getHabitat } from "./_lib/habitat";

const _require = createRequire(import.meta.url);

// Resolve the launcher-envelope module path relative to this extension file.
// The extension lives at pi-sandbox/.pi/extensions/slash-commands.ts; the
// launcher-envelope lives at scripts/_lib/launcher-envelope.mjs (4 levels up).
function getLauncherEnvelopePath(): string {
  return path.resolve(__dirname, "../../../../scripts/_lib/launcher-envelope.mjs");
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
      const agentName = habitat.agentName;

      // Load the launcher-bridge module to send the focus-request.
      let sendControl: ((env: Record<string, unknown>) => boolean) | undefined;
      try {
        // The bridge is loaded by the launcher-bridge extension and stashes its
        // API on globalThis. Access it via the module exports.
        const bridge = _require(
          path.resolve(__dirname, "launcher-bridge"),
        ) as { sendControl?: (env: Record<string, unknown>) => boolean };
        sendControl = bridge.sendControl;
      } catch {
        // launcher-bridge not loaded or not available.
      }

      if (!sendControl) {
        ctx.ui.notify(
          "/focus: launcher-bridge not active (standalone mode). Cannot switch focus.",
          "warning",
        );
        return;
      }

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
}
