// decisions-overlay.ts — focused overlay component for /decisions slash command.
//
// createDecisionsOverlay(opts) returns a pi-tui Component that:
//   - Renders a centered, bordered box showing peers list (top) + decisions queue (bottom).
//   - Handles keyboard navigation:
//       ArrowUp / ArrowDown — move selection between decisions
//       Enter — switch focus to the selected decision's peer, then close
//       p     — pin/unpin the selected decision
//       d     — dismiss the selected decision
//       Esc   — close without action
//
// The component is designed to be passed to ctx.ui.custom(factory, { overlay: true }).

import type { Component } from "@mariozechner/pi-tui";
import type { MeshRailPeer, DecisionSnapshot } from "./mesh-rail";

export interface DecisionsOverlayOptions {
  peers: MeshRailPeer[];
  decisions: DecisionSnapshot[];
  initialSelection?: number;
  onPin: (msg_id: string) => void;
  onUnpin: (msg_id: string) => void;
  onDismiss: (msg_id: string) => void;
  onSwitchFocus: (peer: string) => void;
  onClose: () => void;
}

/** Internal mutable state for the overlay component. */
interface OverlayState {
  peers: MeshRailPeer[];
  decisions: DecisionSnapshot[];
  selectedIndex: number;
}

// ── Box-drawing characters ────────────────────────────────────────────────────

const TL = "╭"; const TR = "╮";
const BL = "╰"; const BR = "╯";
const H  = "─"; const V  = "│";

/** Repeat a character n times. */
function rep(ch: string, n: number): string {
  return n > 0 ? ch.repeat(n) : "";
}

/** Truncate a string to at most maxLen visible characters (no ANSI). */
function trunc(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  if (maxLen <= 1) return s.slice(0, maxLen);
  return s.slice(0, maxLen - 1) + "…";
}

/** Pad or truncate a string to exactly width visible characters. */
function pad(s: string, width: number): string {
  if (s.length < width) return s + " ".repeat(width - s.length);
  return trunc(s, width);
}

// ── State-icon map ────────────────────────────────────────────────────────────

const STATE_ICON: Record<string, string> = {
  spawning: "⏳",
  running:  "●",
  crashed:  "✗",
  exited:   "○",
};

function stateIcon(state: string): string {
  return STATE_ICON[state] ?? "?";
}

// ── Render helpers ────────────────────────────────────────────────────────────

/**
 * Render the overlay to a fixed set of lines.
 *
 * The component is width-aware: the box adapts to the available width.
 * A minimum width of 40 columns is assumed.
 */
function renderOverlay(state: OverlayState, width: number): string[] {
  const inner = Math.max(width - 2, 10); // width minus border columns

  // ── Title bar ──
  const title = " Decisions ";
  const titleLine = TL + title + rep(H, inner - title.length) + TR;

  const lines: string[] = [titleLine];

  // ── Peers section ──
  const peersHeader = V + " Peers " + rep(" ", inner - 7) + V;
  lines.push(peersHeader);

  if (state.peers.length === 0) {
    lines.push(V + pad("  (no peers)", inner) + V);
  } else {
    for (const peer of state.peers) {
      const icon = stateIcon(peer.state);
      const badge = peer.decisionPending ? " ⚑" : "";
      const text = `  ${icon} ${peer.name}${badge}`;
      lines.push(V + pad(text, inner) + V);
    }
  }

  // ── Separator ──
  lines.push(V + rep("·", inner) + V);

  // ── Decisions section ──
  const decisionsHeader = V + " Decisions " + rep(" ", inner - 11) + V;
  lines.push(decisionsHeader);

  if (state.decisions.length === 0) {
    lines.push(V + pad("  (no decisions)", inner) + V);
  } else {
    for (let i = 0; i < state.decisions.length; i++) {
      const dec = state.decisions[i];
      const selected = i === state.selectedIndex;
      const pin = dec.pinned ? "[P]" : "[ ]";
      const prefix = `  ${pin} `;
      const details = `${dec.peer} · ${dec.kind} · ${dec.summary}`;
      const text = prefix + trunc(details, Math.max(0, inner - prefix.length));
      const row = pad(text, inner);
      const rendered = selected ? `>${row.slice(1)}` : row;
      lines.push(V + rendered + V);
    }
  }

  // ── Footer / key hints ──
  const hints = " ↑↓ select  Enter switch  p pin  d dismiss  Esc close ";
  lines.push(V + pad(hints, inner) + V);

  // ── Bottom border ──
  lines.push(BL + rep(H, inner) + BR);

  return lines;
}

// ── Component factory ─────────────────────────────────────────────────────────

export function createDecisionsOverlay(opts: DecisionsOverlayOptions): Component & { update: (patch: Partial<Pick<DecisionsOverlayOptions, "peers" | "decisions">>) => void } {
  const state: OverlayState = {
    peers: [...opts.peers],
    decisions: [...opts.decisions],
    selectedIndex: clamp(opts.initialSelection ?? 0, opts.decisions.length),
  };

  function clampSel(decisions: DecisionSnapshot[]): number {
    if (decisions.length === 0) return 0;
    return Math.min(state.selectedIndex, decisions.length - 1);
  }

  let _invalidate: (() => void) | null = null;
  let _lastWidth = 60;

  const component = {
    // ── Component interface ──────────────────────────────────────────────────

    render(width: number): string[] {
      _lastWidth = width;
      return renderOverlay(state, width);
    },

    invalidate(): void {
      if (_invalidate) _invalidate();
    },

    handleInput(data: string): void {
      // Arrow keys (ANSI escape sequences).
      if (data === "\x1b[A" || data === "\x1bOA") {
        // Arrow Up
        if (state.decisions.length > 0) {
          state.selectedIndex = Math.max(0, state.selectedIndex - 1);
          component.invalidate();
        }
        return;
      }
      if (data === "\x1b[B" || data === "\x1bOB") {
        // Arrow Down
        if (state.decisions.length > 0) {
          state.selectedIndex = Math.min(state.decisions.length - 1, state.selectedIndex + 1);
          component.invalidate();
        }
        return;
      }

      // Enter — switch focus to selected decision's peer and close.
      if (data === "\r" || data === "\n") {
        if (state.decisions.length > 0 && state.selectedIndex < state.decisions.length) {
          const dec = state.decisions[state.selectedIndex];
          opts.onSwitchFocus(dec.peer);
        }
        opts.onClose();
        return;
      }

      // p — pin or unpin the selected decision.
      if (data === "p" || data === "P") {
        if (state.decisions.length > 0 && state.selectedIndex < state.decisions.length) {
          const dec = state.decisions[state.selectedIndex];
          if (dec.pinned) {
            opts.onUnpin(dec.msg_id);
          } else {
            opts.onPin(dec.msg_id);
          }
        }
        return;
      }

      // d — dismiss the selected decision.
      if (data === "d" || data === "D") {
        if (state.decisions.length > 0 && state.selectedIndex < state.decisions.length) {
          const dec = state.decisions[state.selectedIndex];
          opts.onDismiss(dec.msg_id);
          // Optimistically remove from local state; server will send an update.
          state.decisions = state.decisions.filter((d) => d.msg_id !== dec.msg_id);
          state.selectedIndex = clampSel(state.decisions);
          component.invalidate();
        }
        return;
      }

      // Esc — close without action.
      if (data === "\x1b" || data === "\x1b\x1b") {
        opts.onClose();
        return;
      }
    },

    // ── Extension interface for live updates ─────────────────────────────────

    update(patch: Partial<Pick<DecisionsOverlayOptions, "peers" | "decisions">>): void {
      if (patch.peers !== undefined) state.peers = [...patch.peers];
      if (patch.decisions !== undefined) {
        // Preserve selection by msg_id if still present.
        const prevId = state.decisions[state.selectedIndex]?.msg_id;
        state.decisions = [...patch.decisions];
        const newIdx = prevId !== undefined
          ? state.decisions.findIndex((d) => d.msg_id === prevId)
          : -1;
        state.selectedIndex = newIdx >= 0 ? newIdx : clampSel(state.decisions);
      }
      component.invalidate();
    },
  };

  // Expose the invalidate injector so the TUI can wire it.
  (component as any)._setInvalidate = (fn: () => void) => { _invalidate = fn; };

  return component;
}

function clamp(idx: number, len: number): number {
  if (len === 0) return 0;
  return Math.max(0, Math.min(idx, len - 1));
}
