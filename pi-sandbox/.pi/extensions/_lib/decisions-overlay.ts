// decisions-overlay.ts — pure helpers for the decisions overlay component.
//
// createDecisionsOverlayComponent returns a Component + handleInput that renders
// a centered overlay listing all peers and queued decisions. The caller wires
// the component to ctx.ui.custom(..., { overlay: true }).
//
// Keyboard contract (implemented in handleInput):
//   ArrowUp / ArrowDown — move selection through decisions list
//   Enter               — call onFocusPeer(selectedDecision.peer) and close
//   p                   — toggle pin on selected decision
//   d                   — dismiss selected decision
//   Escape              — close without action

import type { Component } from "@mariozechner/pi-tui";
import type { MeshRailPeer, DecisionItem } from "./mesh-rail";

export interface DecisionsOverlayOptions {
  peers: MeshRailPeer[];
  decisions: DecisionItem[];
  /** Called when the overlay should close (done callback from ctx.ui.custom). */
  done: (result: DecisionsOverlayResult) => void;
}

export interface DecisionsOverlayResult {
  action: "close" | "focus-peer";
  peer?: string;
}

export interface DecisionsOverlayComponent extends Component {
  /** handleInput is required (not optional) for overlay keyboard handling. */
  handleInput(data: string): void;
}

// ANSI escape codes for styling (compatible with pi-tui rendering pipeline)
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const REVERSE = "\x1b[7m";

// State icon map (mirrors mesh-rail.ts)
const STATE_ICON: Record<string, string> = {
  spawning: "⏳",
  running: "●",
  crashed: "✗",
  exited: "○",
};

function stateIcon(state: string): string {
  return STATE_ICON[state] ?? "?";
}

/**
 * Create a decisions overlay component.
 *
 * The component is stateful: it holds `selectedIndex` and a mutable copy of
 * `decisions` so that pin/dismiss actions are reflected immediately without a
 * round-trip through the launcher. Callers should re-open the overlay if they
 * need the authoritative state after close.
 */
export function createDecisionsOverlayComponent(opts: DecisionsOverlayOptions): DecisionsOverlayComponent {
  const peers = opts.peers;
  // Mutable decisions copy so pin/dismiss are reflected in render immediately.
  const decisions: DecisionItem[] = opts.decisions.map((d) => ({ ...d }));

  let selectedIndex = decisions.length > 0 ? 0 : -1;
  let _invalidate: (() => void) | null = null;

  function invalidate() {
    if (_invalidate) _invalidate();
  }

  function clampSelection() {
    if (decisions.length === 0) {
      selectedIndex = -1;
    } else {
      selectedIndex = Math.max(0, Math.min(selectedIndex, decisions.length - 1));
    }
  }

  const component: DecisionsOverlayComponent = {
    render(width: number): string[] {
      const lines: string[] = [];

      // ── Header ──────────────────────────────────────────────────────────────
      const title = " Decisions ";
      const border = "─".repeat(Math.max(0, width - 2));
      lines.push(`╭${border}╮`);
      lines.push(`│${BOLD}${title}${RESET}${" ".repeat(Math.max(0, width - 2 - title.length))}│`);
      lines.push(`├${"─".repeat(Math.max(0, width - 2))}┤`);

      // ── Peers section ───────────────────────────────────────────────────────
      const peersLabel = " Peers ";
      lines.push(`│${DIM}${peersLabel}${RESET}${" ".repeat(Math.max(0, width - 2 - peersLabel.length))}│`);

      if (peers.length === 0) {
        const noPeers = "  (no peers)";
        lines.push(`│${DIM}${noPeers}${RESET}${" ".repeat(Math.max(0, width - 2 - noPeers.length))}│`);
      } else {
        for (const peer of peers) {
          const icon = stateIcon(peer.state);
          const badge = peer.decisionPending ? " ⚡" : "";
          const peerLine = `  ${icon} ${peer.name}${badge}`;
          const padded = peerLine.padEnd(width - 2, " ").slice(0, width - 2);
          lines.push(`│${padded}│`);
        }
      }

      // ── Decisions section ───────────────────────────────────────────────────
      lines.push(`├${"─".repeat(Math.max(0, width - 2))}┤`);
      const decisionsLabel = ` Decisions (${decisions.length}) `;
      lines.push(`│${DIM}${decisionsLabel}${RESET}${" ".repeat(Math.max(0, width - 2 - decisionsLabel.length))}│`);

      if (decisions.length === 0) {
        const noDecisions = "  (no pending decisions)";
        lines.push(`│${DIM}${noDecisions}${RESET}${" ".repeat(Math.max(0, width - 2 - noDecisions.length))}│`);
      } else {
        for (let i = 0; i < decisions.length; i++) {
          const d = decisions[i]!;
          const isSelected = i === selectedIndex;
          const pin = d.pinned ? "📌" : "  ";
          const raw = `  ${pin} [${d.peer}] ${d.kind}: ${d.summary}`;
          const padded = raw.padEnd(width - 2, " ").slice(0, width - 2);
          if (isSelected) {
            lines.push(`│${REVERSE}${padded}${RESET}│`);
          } else {
            lines.push(`│${padded}│`);
          }
        }
      }

      // ── Footer (keybindings) ─────────────────────────────────────────────────
      lines.push(`├${"─".repeat(Math.max(0, width - 2))}┤`);
      const keys = " ↑/↓ navigate  Enter focus peer  p pin  d dismiss  Esc close ";
      const keysPadded = keys.padEnd(width - 2, " ").slice(0, width - 2);
      lines.push(`│${DIM}${keysPadded}${RESET}│`);
      lines.push(`╰${"─".repeat(Math.max(0, width - 2))}╯`);

      return lines;
    },

    invalidate(): void {
      // Called by pi-tui when the component should be re-rendered from scratch.
      // Pass to the stored invalidate fn.
      invalidate();
    },

    handleInput(data: string): void {
      // Arrow up
      if (data === "\x1b[A") {
        if (decisions.length > 0 && selectedIndex > 0) {
          selectedIndex--;
          invalidate();
        }
        return;
      }
      // Arrow down
      if (data === "\x1b[B") {
        if (decisions.length > 0 && selectedIndex < decisions.length - 1) {
          selectedIndex++;
          invalidate();
        }
        return;
      }
      // Enter — focus the selected decision's peer
      if (data === "\r" || data === "\n") {
        if (selectedIndex >= 0 && selectedIndex < decisions.length) {
          const d = decisions[selectedIndex]!;
          opts.done({ action: "focus-peer", peer: d.peer });
        } else {
          opts.done({ action: "close" });
        }
        return;
      }
      // p — pin/unpin selected decision
      if (data === "p") {
        if (selectedIndex >= 0 && selectedIndex < decisions.length) {
          decisions[selectedIndex]!.pinned = !decisions[selectedIndex]!.pinned;
          invalidate();
        }
        return;
      }
      // d — dismiss selected decision
      if (data === "d") {
        if (selectedIndex >= 0 && selectedIndex < decisions.length) {
          decisions.splice(selectedIndex, 1);
          clampSelection();
          invalidate();
        }
        return;
      }
      // Escape — close without action
      if (data === "\x1b" || data === "\x1b\x1b") {
        opts.done({ action: "close" });
        return;
      }
    },
  };

  // Expose setter so the overlay system can inject the tui invalidate fn.
  (component as any)._setInvalidate = (fn: () => void) => { _invalidate = fn; };

  return component;
}
