// mesh-rail.ts — in-peer baseline extension that renders a top-right overlay
// summarising mesh state (peer name, peer count, decisions count). Auto-loaded
// by run-agent.mjs only when PI_MESH_PEER=1 (i.e. the peer is running under
// the launcher); raw `npm run pi` and standalone `npm run agent` do not load
// it. The overlay is `nonCapturing` so the editor keeps focus.
//
// This slice (#90) ships static placeholder content. Real signals from the
// launcher (peer-state, decisions count) land in #91.
//
// Slash-command handlers (e.g. /decisions in #93) reach the OverlayHandle via
// the named export `getMeshRailHandle()`, which reads from a globalThis stash
// to survive jiti's per-extension module isolation (same pattern as
// deferred-confirm).

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getHabitat } from "./_lib/habitat";
import {
  createMeshRailComponent,
  meshRailOverlayOptions,
  setMeshRailHandle,
} from "./_lib/mesh-rail";

export {
  getMeshRailHandle,
  setMeshRailHandle,
  clearMeshRailHandle,
} from "./_lib/mesh-rail";

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

    const component = createMeshRailComponent({ peerName });

    // Fire-and-forget: ctx.ui.custom returns a Promise that resolves when the
    // overlay is dismissed via `done(...)`. The mesh-rail overlay is permanent
    // for the lifetime of the session, so we never call done(); the promise
    // never resolves and that's fine.
    void ctx.ui.custom(
      () => component,
      {
        overlay: true,
        overlayOptions: meshRailOverlayOptions(),
        onHandle: (handle) => setMeshRailHandle(handle),
      },
    );
  });
}
