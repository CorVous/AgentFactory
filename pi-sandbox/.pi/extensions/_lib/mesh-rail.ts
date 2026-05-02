// mesh-rail.ts — pure helpers for the mesh-rail widget (component factory).
// The extension default export in ../mesh-rail.ts is a thin wrapper that wires
// session_start to ctx.ui.setWidget with placement "aboveEditor".

import { truncateToWidth, type Component } from "@mariozechner/pi-tui";

export interface MeshRailPeer {
  name: string;
  state: string;
  decisionPending: boolean;
}

export interface DecisionSnapshot {
  msg_id: string;
  peer: string;
  kind: string;
  summary: string;
  ts: number;
  pinned: boolean;
}

export interface MeshRailState {
  peerName: string;
  peers: MeshRailPeer[];
  decisionCount: number;
  decisions: DecisionSnapshot[];
}

export interface MeshRailPatch {
  peers?: MeshRailPeer[];
  decisionCount?: number;
  decisions?: DecisionSnapshot[];
}

export interface MeshRailComponentHandle extends Component {
  /** Partially update live state; missing keys leave existing state unchanged. */
  update(patch: MeshRailPatch): void;
  /** Return a copy of the current state. */
  getState(): MeshRailState;
  /** Hide or show the widget (used by /decisions overlay). */
  setHidden(hidden: boolean): void;
  /** Whether the widget is currently hidden. */
  isHidden(): boolean;
}

export interface MeshRailComponentOptions {
  peerName: string;
  initialPeers?: MeshRailPeer[];
  initialDecisionCount?: number;
  initialDecisions?: DecisionSnapshot[];
}

const SEPARATOR = "  ·  ";

/** Icon shown next to a peer name, keyed by state string. */
const STATE_ICON: Record<string, string> = {
  spawning: "⏳",
  running: "●",
  crashed: "✗",
  exited: "○",
};

function stateIcon(state: string): string {
  return STATE_ICON[state] ?? "?";
}

export function createMeshRailComponent(opts: MeshRailComponentOptions): MeshRailComponentHandle {
  const state: MeshRailState = {
    peerName: opts.peerName,
    peers: opts.initialPeers ?? [],
    decisionCount: opts.initialDecisionCount ?? 0,
    decisions: opts.initialDecisions ?? [],
  };

  /** Invalidation callback injected by pi-tui when the widget is mounted. */
  let _invalidate: (() => void) | null = null;
  /** Whether the widget is hidden (used by /decisions overlay). */
  let _hidden = false;

  const component: MeshRailComponentHandle = {
    render(width: number): string[] {
      // When hidden, return no lines so the widget takes no space.
      if (_hidden) return [];

      const peerCount = state.peers.length;
      const peerSummary =
        peerCount === 0
          ? "0 peers"
          : state.peers.map((p) => `${stateIcon(p.state)} ${p.name}`).join(", ");

      const decisionSummary =
        state.decisionCount === 1
          ? "1 decision"
          : `${state.decisionCount} decisions`;

      const line = [state.peerName, peerSummary, decisionSummary].join(SEPARATOR);
      return [truncateToWidth(line, width, "…")];
    },

    invalidate(): void {
      // Called by pi-tui when the widget should be re-rendered.
      if (_invalidate) _invalidate();
    },

    update(patch: MeshRailPatch): void {
      if (patch.peers !== undefined) state.peers = patch.peers;
      if (patch.decisionCount !== undefined) state.decisionCount = patch.decisionCount;
      if (patch.decisions !== undefined) state.decisions = patch.decisions;
      // Trigger pi-tui re-render by calling the stored invalidate callback.
      if (_invalidate) _invalidate();
    },

    getState(): MeshRailState {
      return { ...state, peers: [...state.peers], decisions: [...state.decisions] };
    },

    setHidden(hidden: boolean): void {
      if (_hidden === hidden) return;
      _hidden = hidden;
      // Trigger re-render so the widget either disappears or reappears.
      if (_invalidate) _invalidate();
    },

    isHidden(): boolean {
      return _hidden;
    },
  };

  // Expose setter so the extension wrapper can inject the tui invalidate fn.
  (component as any)._setInvalidate = (fn: () => void) => { _invalidate = fn; };

  return component;
}

// ── Handle stash (globalThis, survives jiti module isolation) ─────────────────

interface MeshRailHandleStash {
  handle: MeshRailComponentHandle | null;
}

function getStash(): MeshRailHandleStash {
  const g = globalThis as { __pi_mesh_rail__?: MeshRailHandleStash };
  return (g.__pi_mesh_rail__ ??= { handle: null });
}

export function setMeshRailHandle(handle: MeshRailComponentHandle): void {
  getStash().handle = handle;
}

export function getMeshRailHandle(): MeshRailComponentHandle | null {
  return getStash().handle;
}

export function clearMeshRailHandle(): void {
  getStash().handle = null;
}
