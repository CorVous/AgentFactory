// mesh-rail.ts — pure helpers for the mesh-rail widget (component factory).
// The extension default export in ../mesh-rail.ts is a thin wrapper that wires
// session_start to ctx.ui.setWidget with placement "aboveEditor".

import { truncateToWidth, type Component } from "@mariozechner/pi-tui";

export interface MeshRailComponentOptions {
  peerName: string;
}

const SEPARATOR = "  ·  ";

export function createMeshRailComponent(opts: MeshRailComponentOptions): Component {
  return {
    render(width: number): string[] {
      // Single-line, borderless layout: fields joined by a middle-dot separator.
      const line = [opts.peerName, "0 peers", "0 decisions"].join(SEPARATOR);
      return [truncateToWidth(line, width, "…")];
    },
    invalidate(): void {
      // Static placeholder content; nothing to invalidate yet.
      // Real signal-driven re-renders land in the follow-up slice (#91).
    },
  };
}
