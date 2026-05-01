// mesh-rail.ts — in-peer baseline extension that renders a mesh-status widget
// above the editor (chat input bar) summarising peer name, peer count, and
// decisions count. Auto-loaded by run-agent.mjs only when PI_MESH_PEER=1 (i.e.
// the peer is running under the launcher); raw `npm run pi` and standalone
// `npm run agent` do not load it. Mounted via `ctx.ui.setWidget(..., {
// placement: "aboveEditor" })`, so it sits in the layout flow directly above
// the input area rather than floating as an overlay.
//
// This slice (#90) ships static placeholder content. Real signals from the
// launcher (peer-state, decisions count) land in #91.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getHabitat } from "./_lib/habitat";
import { createMeshRailComponent } from "./_lib/mesh-rail";

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

    ctx.ui.setWidget(
      "mesh-rail",
      () => createMeshRailComponent({ peerName }),
      { placement: "aboveEditor" },
    );
  });
}
