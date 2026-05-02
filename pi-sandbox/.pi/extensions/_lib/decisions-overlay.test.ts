/**
 * decisions-overlay.test.ts — hermetic unit tests for the decisions overlay component.
 *
 * Contract: no I/O, no network, no env from models.env, no real pi runtime.
 */

import { describe, it, expect, vi } from "vitest";
import { createDecisionsOverlay } from "./decisions-overlay";
import type { MeshRailPeer, DecisionSnapshot } from "./mesh-rail";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PEERS: MeshRailPeer[] = [
  { name: "peer-a", state: "running", decisionPending: false },
  { name: "peer-b", state: "crashed", decisionPending: true },
];

const DECISIONS: DecisionSnapshot[] = [
  { msg_id: "m1", peer: "peer-a", kind: "approval-request", summary: "approve build?", ts: 1000, pinned: false },
  { msg_id: "m2", peer: "peer-b", kind: "submission",       summary: "3 artifacts",    ts: 2000, pinned: true  },
];

function makeOverlay(overrides?: Partial<Parameters<typeof createDecisionsOverlay>[0]>) {
  const onPin      = vi.fn();
  const onUnpin    = vi.fn();
  const onDismiss  = vi.fn();
  const onSwitchFocus = vi.fn();
  const onClose    = vi.fn();

  const overlay = createDecisionsOverlay({
    peers: PEERS,
    decisions: DECISIONS,
    onPin,
    onUnpin,
    onDismiss,
    onSwitchFocus,
    onClose,
    ...overrides,
  });

  return { overlay, onPin, onUnpin, onDismiss, onSwitchFocus, onClose };
}

// ── Render ────────────────────────────────────────────────────────────────────

describe("createDecisionsOverlay — render output", () => {
  it("contains all peer names", () => {
    const { overlay } = makeOverlay();
    const output = overlay.render(80).join("\n");
    expect(output).toContain("peer-a");
    expect(output).toContain("peer-b");
  });

  it("contains all decision entries (peer, kind, summary)", () => {
    const { overlay } = makeOverlay();
    const output = overlay.render(80).join("\n");
    expect(output).toContain("peer-a");
    expect(output).toContain("approval-request");
    expect(output).toContain("approve build?");
  });

  it("shows [P] pin marker for pinned decisions", () => {
    const { overlay } = makeOverlay();
    const output = overlay.render(80).join("\n");
    expect(output).toContain("[P]");
  });

  it("shows [ ] pin marker for unpinned decisions", () => {
    const { overlay } = makeOverlay();
    const output = overlay.render(80).join("\n");
    expect(output).toContain("[ ]");
  });

  it("selection indicator (>) appears on the selected row (first by default)", () => {
    const { overlay } = makeOverlay();
    const lines = overlay.render(80);
    const selectedLine = lines.find((l) => l.includes(">"));
    expect(selectedLine).toBeDefined();
    // The first decision (m1) should be selected.
    expect(selectedLine).toContain("approve build?");
  });

  it("shows '(no decisions)' placeholder when decisions list is empty", () => {
    const { overlay } = makeOverlay({ decisions: [] });
    const output = overlay.render(80).join("\n");
    expect(output).toContain("(no decisions)");
  });

  it("shows '(no peers)' placeholder when peers list is empty", () => {
    const { overlay } = makeOverlay({ peers: [] });
    const output = overlay.render(80).join("\n");
    expect(output).toContain("(no peers)");
  });

  it("renders a bordered box (contains box-drawing characters)", () => {
    const { overlay } = makeOverlay();
    const output = overlay.render(80).join("");
    expect(output).toMatch(/[╭╮╰╯│─]/);
  });

  it("returns an array of strings (lines)", () => {
    const { overlay } = makeOverlay();
    const lines = overlay.render(80);
    expect(Array.isArray(lines)).toBe(true);
    for (const l of lines) expect(typeof l).toBe("string");
  });

  it("contains keyboard hints in the footer", () => {
    const { overlay } = makeOverlay();
    const output = overlay.render(80).join("\n");
    expect(output).toContain("Esc");
  });
});

// ── Arrow-key navigation ──────────────────────────────────────────────────────

describe("createDecisionsOverlay — arrow-key navigation", () => {
  it("ArrowDown moves selection to the next decision", () => {
    const { overlay } = makeOverlay();
    overlay.handleInput!("\x1b[B"); // Arrow Down
    const lines = overlay.render(80);
    // The second decision (m2, summary "3 artifacts") should now be highlighted.
    const selectedLine = lines.find((l) => l.includes(">"));
    expect(selectedLine).toContain("3 artifacts");
  });

  it("ArrowUp at index 0 stays at 0 (clamped)", () => {
    const { overlay } = makeOverlay();
    overlay.handleInput!("\x1b[A"); // Arrow Up — already at 0
    const lines = overlay.render(80);
    // First decision should still be selected.
    const selectedLine = lines.find((l) => l.includes(">"));
    expect(selectedLine).toContain("approve build?");
  });

  it("ArrowDown at last item stays at last (clamped)", () => {
    const { overlay } = makeOverlay();
    overlay.handleInput!("\x1b[B"); // Down to index 1
    overlay.handleInput!("\x1b[B"); // Down beyond end — should clamp to 1
    const lines = overlay.render(80);
    const selectedLine = lines.find((l) => l.includes(">"));
    expect(selectedLine).toContain("3 artifacts");
  });

  it("ArrowDown on empty decisions list does nothing (no throw)", () => {
    const { overlay } = makeOverlay({ decisions: [] });
    expect(() => overlay.handleInput!("\x1b[B")).not.toThrow();
  });
});

// ── Enter ─────────────────────────────────────────────────────────────────────

describe("createDecisionsOverlay — Enter key", () => {
  it("Enter calls onSwitchFocus with the selected decision's peer", () => {
    const { overlay, onSwitchFocus } = makeOverlay();
    overlay.handleInput!("\r");
    expect(onSwitchFocus).toHaveBeenCalledWith("peer-a");
  });

  it("Enter also calls onClose", () => {
    const { overlay, onClose } = makeOverlay();
    overlay.handleInput!("\r");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter on second decision switches to peer-b", () => {
    const { overlay, onSwitchFocus } = makeOverlay();
    overlay.handleInput!("\x1b[B"); // Down to m2
    overlay.handleInput!("\r");
    expect(onSwitchFocus).toHaveBeenCalledWith("peer-b");
  });

  it("Enter on empty decisions list calls onClose but not onSwitchFocus", () => {
    const { overlay, onSwitchFocus, onClose } = makeOverlay({ decisions: [] });
    overlay.handleInput!("\r");
    expect(onSwitchFocus).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── p key (pin/unpin) ─────────────────────────────────────────────────────────

describe("createDecisionsOverlay — p key (pin/unpin)", () => {
  it("p on an unpinned decision calls onPin with msg_id", () => {
    const { overlay, onPin } = makeOverlay();
    // First decision (m1) is unpinned.
    overlay.handleInput!("p");
    expect(onPin).toHaveBeenCalledWith("m1");
  });

  it("p on a pinned decision calls onUnpin with msg_id", () => {
    const { overlay, onUnpin } = makeOverlay();
    overlay.handleInput!("\x1b[B"); // Down to m2 (pinned)
    overlay.handleInput!("p");
    expect(onUnpin).toHaveBeenCalledWith("m2");
  });

  it("p on empty list does not throw and calls nothing", () => {
    const { overlay, onPin, onUnpin } = makeOverlay({ decisions: [] });
    expect(() => overlay.handleInput!("p")).not.toThrow();
    expect(onPin).not.toHaveBeenCalled();
    expect(onUnpin).not.toHaveBeenCalled();
  });
});

// ── d key (dismiss) ───────────────────────────────────────────────────────────

describe("createDecisionsOverlay — d key (dismiss)", () => {
  it("d calls onDismiss with the selected decision's msg_id", () => {
    const { overlay, onDismiss } = makeOverlay();
    overlay.handleInput!("d");
    expect(onDismiss).toHaveBeenCalledWith("m1");
  });

  it("d removes the item from the local decisions list", () => {
    const { overlay } = makeOverlay();
    overlay.handleInput!("d"); // dismiss m1
    const output = overlay.render(80).join("\n");
    // m1 should no longer appear; m2 should still be there.
    expect(output).not.toContain("approve build?");
    expect(output).toContain("3 artifacts");
  });

  it("d clamps selection after removal", () => {
    const { overlay } = makeOverlay();
    overlay.handleInput!("\x1b[B"); // Down to m2 (index 1 = last)
    overlay.handleInput!("d");       // dismiss m2 — list now has only m1
    const lines = overlay.render(80);
    // m1 should be selected (clamped to 0).
    const selectedLine = lines.find((l) => l.includes(">"));
    expect(selectedLine).toContain("approve build?");
  });

  it("d on empty list does nothing", () => {
    const { overlay, onDismiss } = makeOverlay({ decisions: [] });
    expect(() => overlay.handleInput!("d")).not.toThrow();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

// ── Esc key ───────────────────────────────────────────────────────────────────

describe("createDecisionsOverlay — Esc key", () => {
  it("Esc calls onClose", () => {
    const { overlay, onClose } = makeOverlay();
    overlay.handleInput!("\x1b");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc does NOT call onSwitchFocus", () => {
    const { overlay, onSwitchFocus } = makeOverlay();
    overlay.handleInput!("\x1b");
    expect(onSwitchFocus).not.toHaveBeenCalled();
  });

  it("Esc does NOT call onPin/onUnpin/onDismiss", () => {
    const { overlay, onPin, onUnpin, onDismiss } = makeOverlay();
    overlay.handleInput!("\x1b");
    expect(onPin).not.toHaveBeenCalled();
    expect(onUnpin).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

// ── update() ─────────────────────────────────────────────────────────────────

describe("createDecisionsOverlay — update()", () => {
  it("update({decisions: [...]}) reflects new decisions in render", () => {
    const { overlay } = makeOverlay();
    overlay.update({ decisions: [
      { msg_id: "m3", peer: "peer-c", kind: "submission", summary: "new item", ts: 3000, pinned: false },
    ] });
    const output = overlay.render(80).join("\n");
    expect(output).toContain("new item");
    expect(output).not.toContain("approve build?");
  });

  it("update({peers: [...]}) reflects new peers in the peers section", () => {
    // Replace peers with a single new peer. The decisions section may still
    // reference "peer-b" by name, but the peers list should only show peer-x.
    const { overlay } = makeOverlay();
    overlay.update({ peers: [{ name: "peer-x", state: "exited", decisionPending: false }] });
    const output = overlay.render(80).join("\n");
    expect(output).toContain("peer-x");
    // peer-a should no longer appear in the peers section (may still appear in decisions).
    // Check that ● peer-a is gone from the peers icon list.
    expect(output).not.toContain("● peer-a");
  });

  it("update() preserves selectedIndex by msg_id when the item is still present", () => {
    const { overlay } = makeOverlay();
    overlay.handleInput!("\x1b[B"); // select m2
    overlay.update({ decisions: [
      { msg_id: "m1", peer: "peer-a", kind: "approval-request", summary: "approve build?", ts: 1000, pinned: false },
      { msg_id: "m2", peer: "peer-b", kind: "submission",       summary: "3 artifacts",    ts: 2000, pinned: true  },
    ] });
    const lines = overlay.render(80);
    const selectedLine = lines.find((l) => l.includes(">"));
    expect(selectedLine).toContain("3 artifacts");
  });

  it("update() clamps selection when the previously-selected item is removed", () => {
    const { overlay } = makeOverlay();
    overlay.handleInput!("\x1b[B"); // select m2
    // Update with only m1 — m2 is gone.
    overlay.update({ decisions: [
      { msg_id: "m1", peer: "peer-a", kind: "approval-request", summary: "approve build?", ts: 1000, pinned: false },
    ] });
    const lines = overlay.render(80);
    const selectedLine = lines.find((l) => l.includes(">"));
    expect(selectedLine).toContain("approve build?");
  });
});

// ── invalidate callback ───────────────────────────────────────────────────────

describe("createDecisionsOverlay — invalidate", () => {
  it("implements invalidate() without throwing", () => {
    const { overlay } = makeOverlay();
    expect(() => overlay.invalidate()).not.toThrow();
  });
});
