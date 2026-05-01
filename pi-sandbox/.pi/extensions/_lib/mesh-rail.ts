// mesh-rail.ts — pure helpers for the mesh-rail overlay (state, component factory,
// overlay options, globalThis handle stash). The extension default export in
// ../mesh-rail.ts is a thin wrapper that wires session_start to ctx.ui.custom.

import type { Component, OverlayHandle, OverlayOptions } from "@mariozechner/pi-tui";

export interface MeshRailComponentOptions {
  peerName: string;
}

export function createMeshRailComponent(opts: MeshRailComponentOptions): Component {
  return {
    render(width: number): string[] {
      const content = [opts.peerName, "0 peers", "0 decisions"];
      // Frame is left-anchored: rounded top-left + horizontals across, left
      // bar on each content line, rounded bottom-left + horizontals across.
      // Right side is intentionally open — the overlay sits against the
      // terminal's right edge, so a right border would just be wasted ink.
      const longest = content.reduce((m, s) => Math.max(m, s.length), 0);
      // Total visible width: at least longest content + 2 (left bar + space),
      // expanding to fill the column budget pi-tui hands us.
      const total = Math.max(longest + 2, width);
      const top = "╭" + "─".repeat(total - 1);
      const bottom = "╰" + "─".repeat(total - 1);
      const body = content.map((line) => {
        const padded = ` ${line}`.padEnd(total - 1, " ");
        return `│${padded}`;
      });
      return [top, ...body, bottom];
    },
    invalidate(): void {
      // Static placeholder content; nothing to invalidate yet.
      // Real signal-driven re-renders land in the follow-up slice (#91).
    },
  };
}

interface MeshRailState {
  handle?: OverlayHandle;
}

function getState(): MeshRailState {
  const g = globalThis as { __pi_mesh_rail__?: MeshRailState };
  return (g.__pi_mesh_rail__ ??= {});
}

export function getMeshRailHandle(): OverlayHandle | undefined {
  return getState().handle;
}

export function setMeshRailHandle(handle: OverlayHandle): void {
  getState().handle = handle;
}

export function clearMeshRailHandle(): void {
  delete getState().handle;
}

export function meshRailOverlayOptions(): OverlayOptions {
  return {
    anchor: "top-right",
    width: "30%",
    maxHeight: 6,
    margin: { top: 1 },
    nonCapturing: true,
  };
}
