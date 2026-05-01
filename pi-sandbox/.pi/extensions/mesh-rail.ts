// mesh-rail.ts — in-peer baseline extension that renders a mesh-status widget
// above the editor (chat input bar) summarising peer name, peer count, and
// decisions count. Auto-loaded by run-agent.mjs only when PI_MESH_PEER=1 (i.e.
// the peer is running under the launcher); raw `npm run pi` and standalone
// `npm run agent` do not load it. Mounted via `ctx.ui.setWidget(..., {
// placement: "aboveEditor" })`, so it sits in the layout flow directly above
// the input area rather than floating as an overlay.
//
// Signals from the launcher (peer-state, decisions count) are received via the
// `launcher-bridge` onMeshRailUpdate subscription and drive live re-renders.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getHabitat } from "./_lib/habitat";
import {
  createMeshRailComponent,
  setMeshRailHandle,
  clearMeshRailHandle,
} from "./_lib/mesh-rail";
import { onMeshRailUpdate } from "./launcher-bridge";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    let peerName: string;
    try {
      peerName = getHabitat().agentName;
    } catch {
      // Habitat not materialised — degrade silently (defensive; the runner
      // always loads habitat first, so this branch should not normally hit).
      return;
    }

    const handle = createMeshRailComponent({ peerName });
    setMeshRailHandle(handle);

    // Subscribe to launcher broadcasts. On each update, patch the component
    // state and trigger a re-render via the invalidate callback.
    onMeshRailUpdate((env: any) => {
      if (!env || !Array.isArray(env.peers)) return;
      handle.update({
        peers: env.peers,
        decisionCount: typeof env.decisionCount === "number" ? env.decisionCount : 0,
      });
    });

    ctx.ui.setWidget(
      "mesh-rail",
      () => {
        // Re-register the factory on each re-render request so pi-tui picks
        // up the latest state. The component's invalidate() is called by
        // pi-tui; we wire the tui's requestRender trigger via setWidget.
        return handle;
      },
      { placement: "aboveEditor" },
    );
  });

  pi.on("session_end", async () => {
    clearMeshRailHandle();
  });
}
