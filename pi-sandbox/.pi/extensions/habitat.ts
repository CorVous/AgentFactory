// habitat — baseline extension that materialises the per-instance
// containment perimeter once at session_start and stashes it on
// globalThis for all other rails to read via getHabitat().
//
// The runner serialises the fully-resolved Habitat into a single
// --habitat-spec <json> flag. On fallback (direct `pi` invocations
// without the runner), a minimal Habitat is assembled from ctx.cwd
// (agentName defaults to "anonymous"; debug is always false in this path).
//
// This extension must be first in the peer template's extension list so it
// runs before any rail that calls getHabitat() in its own session_start.

import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { materialiseHabitat, setHabitat, type Habitat } from "./_lib/habitat";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("habitat-spec", {
    description: "JSON-serialised Habitat spec built by scripts/run-agent.mjs",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    const raw = (pi.getFlag("habitat-spec") as string | undefined)?.trim();

    if (raw) {
      try {
        const h = materialiseHabitat(raw);
        setHabitat(h);
        if (h.debug === true) {
          const dump = `habitat: agentName=${h.agentName} scratchRoot=${h.scratchRoot} busRoot=${h.busRoot}` +
            (h.supervisor ? ` supervisor=${h.supervisor}` : "") +
            (h.submitTo ? ` submitTo=${h.submitTo}` : "") +
            (h.acceptedFrom.length ? ` acceptedFrom=[${h.acceptedFrom.join(",")}]` : "") +
            (h.peers.length ? ` peers=[${h.peers.join(",")}]` : "");
          ctx.ui.notify(dump, "info");
          process.stderr.write(`[habitat] ${dump}\n`);
        }
        return;
      } catch (e) {
        ctx.ui.notify(`habitat: malformed --habitat-spec: ${(e as Error).message}`, "warning");
        // fall through to fallback
      }
    }

    // Fallback for direct `pi` invocations that don't pass --habitat-spec.
    const agentName = "anonymous";
    const scratchRoot = path.resolve(ctx.cwd);
    const busRoot = path.join(os.homedir(), ".pi-agent-bus", path.basename(scratchRoot));

    const fallback: Habitat = {
      agentName,
      scratchRoot,
      busRoot,
      skills: [],
      agents: [],
      debug: false,
      acceptedFrom: [],
      peers: [],
    };
    setHabitat(fallback);

    if (fallback.debug === true) {
      const dump = `habitat: fallback agentName=${fallback.agentName} scratchRoot=${fallback.scratchRoot}`;
      ctx.ui.notify(dump, "info");
      process.stderr.write(`[habitat] ${dump}\n`);
    }
  });
}
