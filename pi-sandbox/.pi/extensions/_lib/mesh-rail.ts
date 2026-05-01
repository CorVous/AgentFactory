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
      // Inner width is the box width minus the two side bars; clamp so we
      // always fit the longest content line plus one space of padding.
      const longest = content.reduce((m, s) => Math.max(m, s.length), 0);
      const inner = Math.max(longest + 2, width - 2);
      const border = `+${"-".repeat(inner)}+`;
      const body = content.map((line) => {
        const padded = ` ${line}`.padEnd(inner, " ");
        return `|${padded}|`;
      });
      return [border, ...body, border];
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
