// mesh-rail.ts — in-peer baseline extension that renders a mesh-status widget
// above the editor (chat input bar) summarising peer name, peer count, and
// decisions count. Loaded via the peer template (pi-sandbox/templates/peer.yaml),
// so the peer is running under the launcher; raw `npm run pi` and standalone
// `npm run agent` do not load it. Mounted via `ctx.ui.setWidget(..., {
// placement: "aboveEditor" })`, so it sits in the layout flow directly above
// the input area rather than floating as an overlay.
//
// Signals from the launcher (peer-state, decisions count) are received via the
// `launcher-bridge` onMeshRailUpdate subscription and drive live re-renders.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHabitat } from "../lib/habitat.js";
import {
  createMeshRailComponent,
  setMeshRailHandle,
  clearMeshRailHandle,
} from "../lib/mesh-rail.js";
import { onMeshRailUpdate, getFocusState } from "./launcher-bridge.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    let peerName: string;
    try {
      peerName = getHabitat().instanceName;
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
        decisions: Array.isArray(env.decisions) ? env.decisions : undefined,
      });
    });

    // Stash the TUI reference so the focus-in handler below can call
    // requestRender(true). Extensions only get a TUI handle via component
    // factories; this widget is part of the peer template, so the
    // factory is guaranteed to run before any focus-changed event matters.
    let tuiRef: { requestRender?: (force?: boolean) => void } | undefined;

    ctx.ui.setWidget(
      "mesh-rail",
      (tui) => {
        tuiRef = tui as unknown as { requestRender?: (force?: boolean) => void };
        // Inject the invalidate callback so component.update() can trigger
        // an active re-render rather than waiting for the next natural frame.
        (handle as any)._setInvalidate(() => tuiRef?.requestRender?.());
        return handle;
      },
      { placement: "aboveEditor" },
    );

    // When this peer becomes the focused peer in the launcher, force pi's
    // renderer to clear and redraw from scratch. The launcher-side hard-reset
    // wipes the terminal but pi's diff-render machinery still believes the
    // screen contains its previousLines, so without force=true subsequent
    // updates only emit the diff and the screen stays "stale" in the user's
    // real terminal. requestRender(true) resets previousLines/cursorRow and
    // re-emits the full TUI through the PTY.
    getFocusState().on("focus-changed", ({ focused }: { focused: boolean }) => {
      if (focused) tuiRef?.requestRender?.(true);
    });
  });

  pi.on("session_end", async () => {
    clearMeshRailHandle();
  });
}
