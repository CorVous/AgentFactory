/**
 * decisions-overlay.test.ts — hermetic unit tests for the decisions overlay component.
 *
 * Contract: no I/O, no network, no env from models.env, no real pi runtime.
 */

import { describe, it, expect, vi } from "vitest";
import { createDecisionsOverlayComponent } from "./decisions-overlay";
import { createMeshRailComponent } from "./mesh-rail";
import type { DecisionItem, MeshRailPeer } from "./mesh-rail";

// ── Render output ────────────────────────────────────────────────────────────

describe("createDecisionsOverlayComponent — render output", () => {
  const samplePeers: MeshRailPeer[] = [
    { name: "worker-a", state: "running", decisionPending: false },
    { name: "authority", state: "spawning", decisionPending: true },
  ];

  const sampleDecisions: DecisionItem[] = [
    { msg_id: "m1", peer: "worker-a", kind: "approval-request", summary: "build step", pinned: false },
    { msg_id: "m2", peer: "authority", kind: "submission", summary: "3 artifacts", pinned: true },
  ];

  it("renders box drawing borders (╭, ╰, │, ─)", () => {
    const component = createDecisionsOverlayComponent({
      peers: samplePeers,
      decisions: sampleDecisions,
      done: vi.fn(),
    });
    const output = component.render(60).join("\n");
    expect(output).toContain("╭");
    expect(output).toContain("╰");
    expect(output).toContain("│");
    expect(output).toContain("─");
  });

  it("includes all peer names in the output", () => {
    const component = createDecisionsOverlayComponent({
      peers: samplePeers,
      decisions: sampleDecisions,
      done: vi.fn(),
    });
    const output = component.render(80).join("\n");
    expect(output).toContain("worker-a");
    expect(output).toContain("authority");
  });

  it("includes all decision summaries in the output", () => {
    const component = createDecisionsOverlayComponent({
      peers: samplePeers,
      decisions: sampleDecisions,
      done: vi.fn(),
    });
    const output = component.render(80).join("\n");
    expect(output).toContain("build step");
    expect(output).toContain("3 artifacts");
  });

  it("shows peer kind in decision rows", () => {
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [
        { msg_id: "x", peer: "worker", kind: "submission", summary: "stuff", pinned: false },
      ],
      done: vi.fn(),
    });
    const output = component.render(80).join("\n");
    expect(output).toContain("submission");
    expect(output).toContain("worker");
  });

  it("renders keybindings hint in footer", () => {
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [],
      done: vi.fn(),
    });
    const output = component.render(80).join("\n");
    expect(output).toContain("Esc");
    expect(output).toContain("Enter");
  });

  it("renders (no peers) placeholder when peers list is empty", () => {
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [],
      done: vi.fn(),
    });
    const output = component.render(80).join("\n");
    expect(output).toContain("no peers");
  });

  it("renders (no pending decisions) placeholder when decisions list is empty", () => {
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [],
      done: vi.fn(),
    });
    const output = component.render(80).join("\n");
    expect(output).toContain("no pending decisions");
  });

  it("returns an array of strings", () => {
    const component = createDecisionsOverlayComponent({
      peers: samplePeers,
      decisions: sampleDecisions,
      done: vi.fn(),
    });
    const lines = component.render(80);
    expect(Array.isArray(lines)).toBe(true);
    for (const line of lines) {
      expect(typeof line).toBe("string");
    }
  });

  it("first decision is visually selected (ANSI reverse on selected line)", () => {
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [
        { msg_id: "a", peer: "p1", kind: "k", summary: "first", pinned: false },
        { msg_id: "b", peer: "p2", kind: "k", summary: "second", pinned: false },
      ],
      done: vi.fn(),
    });
    const lines = component.render(80);
    // ANSI reverse = \x1b[7m — should appear on the "first" row but not the "second" row.
    const firstLine = lines.find((l) => l.includes("first"));
    const secondLine = lines.find((l) => l.includes("second"));
    expect(firstLine).toContain("\x1b[7m");
    expect(secondLine).not.toContain("\x1b[7m");
  });

  it("state icon for spawning peer appears in rendered output", () => {
    const component = createDecisionsOverlayComponent({
      peers: [{ name: "peer-a", state: "spawning", decisionPending: false }],
      decisions: [],
      done: vi.fn(),
    });
    const output = component.render(80).join("\n");
    expect(output).toContain("⏳");
  });

  it("state icon for crashed peer appears in rendered output", () => {
    const component = createDecisionsOverlayComponent({
      peers: [{ name: "peer-a", state: "crashed", decisionPending: false }],
      decisions: [],
      done: vi.fn(),
    });
    const output = component.render(80).join("\n");
    expect(output).toContain("✗");
  });
});

// ── Keyboard navigation ───────────────────────────────────────────────────────

describe("createDecisionsOverlayComponent — keyboard navigation", () => {
  it("ArrowDown advances selection; ArrowUp moves back", () => {
    let _invalidated = false;
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [
        { msg_id: "a", peer: "p1", kind: "k", summary: "first", pinned: false },
        { msg_id: "b", peer: "p2", kind: "k", summary: "second", pinned: false },
      ],
      done: vi.fn(),
    });
    (component as any)._setInvalidate(() => { _invalidated = true; });

    // Initially first item is selected (has reverse)
    let output = component.render(80).join("\n");
    const firstLine1 = output.split("\n").find((l) => l.includes("first"));
    expect(firstLine1).toContain("\x1b[7m");

    // ArrowDown → second item selected
    component.handleInput("\x1b[B");
    output = component.render(80).join("\n");
    const secondLine = output.split("\n").find((l) => l.includes("second"));
    expect(secondLine).toContain("\x1b[7m");
    expect(_invalidated).toBe(true);

    // ArrowUp → first item selected again
    component.handleInput("\x1b[A");
    output = component.render(80).join("\n");
    const firstLine2 = output.split("\n").find((l) => l.includes("first"));
    expect(firstLine2).toContain("\x1b[7m");
  });

  it("ArrowUp does not go below index 0", () => {
    let invalidateCount = 0;
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [{ msg_id: "a", peer: "p1", kind: "k", summary: "only", pinned: false }],
      done: vi.fn(),
    });
    (component as any)._setInvalidate(() => { invalidateCount++; });

    component.handleInput("\x1b[A"); // already at 0
    expect(invalidateCount).toBe(0); // no re-render needed
  });

  it("ArrowDown does not go past last item", () => {
    let invalidateCount = 0;
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [{ msg_id: "a", peer: "p1", kind: "k", summary: "only", pinned: false }],
      done: vi.fn(),
    });
    (component as any)._setInvalidate(() => { invalidateCount++; });

    component.handleInput("\x1b[B"); // already at last
    expect(invalidateCount).toBe(0);
  });

  it("Escape calls done with action:close", () => {
    const done = vi.fn();
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [],
      done,
    });
    component.handleInput("\x1b");
    expect(done).toHaveBeenCalledWith({ action: "close" });
  });

  it("Enter on empty decisions calls done with action:close", () => {
    const done = vi.fn();
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [],
      done,
    });
    component.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ action: "close" });
  });

  it("Enter on a selected decision calls done with action:focus-peer and the peer", () => {
    const done = vi.fn();
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [
        { msg_id: "a", peer: "worker-a", kind: "approval-request", summary: "s", pinned: false },
      ],
      done,
    });
    component.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ action: "focus-peer", peer: "worker-a" });
  });

  it("Enter on second decision (after ArrowDown) focuses the second peer", () => {
    const done = vi.fn();
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [
        { msg_id: "a", peer: "worker-a", kind: "k", summary: "s1", pinned: false },
        { msg_id: "b", peer: "worker-b", kind: "k", summary: "s2", pinned: false },
      ],
      done,
    });
    component.handleInput("\x1b[B"); // ArrowDown to second
    component.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ action: "focus-peer", peer: "worker-b" });
  });
});

// ── Pin / Dismiss affordances ─────────────────────────────────────────────────

describe("createDecisionsOverlayComponent — pin and dismiss", () => {
  it("p toggles pin on the selected decision", () => {
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [{ msg_id: "a", peer: "p1", kind: "k", summary: "s", pinned: false }],
      done: vi.fn(),
    });
    // Before: not pinned
    let output = component.render(80).join("\n");
    expect(output).not.toContain("📌");

    component.handleInput("p");

    // After: pinned indicator visible
    output = component.render(80).join("\n");
    expect(output).toContain("📌");
  });

  it("p toggles pin back to unpinned on second press", () => {
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [{ msg_id: "a", peer: "p1", kind: "k", summary: "s", pinned: true }],
      done: vi.fn(),
    });
    // Starts pinned
    expect(component.render(80).join("\n")).toContain("📌");

    component.handleInput("p");
    // Now unpinned
    expect(component.render(80).join("\n")).not.toContain("📌");
  });

  it("d dismisses the selected decision and removes it from the list", () => {
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [
        { msg_id: "a", peer: "p1", kind: "k", summary: "first-decision", pinned: false },
        { msg_id: "b", peer: "p2", kind: "k", summary: "second-decision", pinned: false },
      ],
      done: vi.fn(),
    });
    component.handleInput("d"); // dismiss first (selected by default)
    const output = component.render(80).join("\n");
    expect(output).not.toContain("first-decision");
    expect(output).toContain("second-decision");
  });

  it("d on last remaining decision shows no-pending-decisions placeholder", () => {
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [{ msg_id: "a", peer: "p1", kind: "k", summary: "only-one", pinned: false }],
      done: vi.fn(),
    });
    component.handleInput("d");
    const output = component.render(80).join("\n");
    expect(output).toContain("no pending decisions");
  });

  it("p on empty decisions list does not throw", () => {
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [],
      done: vi.fn(),
    });
    expect(() => component.handleInput("p")).not.toThrow();
  });

  it("d on empty decisions list does not throw", () => {
    const component = createDecisionsOverlayComponent({
      peers: [],
      decisions: [],
      done: vi.fn(),
    });
    expect(() => component.handleInput("d")).not.toThrow();
  });
});

// ── Rail visibility contract: rail stays visible across all overlays ─────────

describe("MeshRailHandle visibility contract while decisions overlay is open", () => {
  it("rail render() keeps producing output while a decisions overlay is in use", () => {
    // Both surfaces (the rail above the editor and the decisions overlay) coexist.
    // The human keeps ambient peer-state context from the rail while picking an
    // action in the overlay.
    const rail = createMeshRailComponent({ peerName: "me" });

    const before = rail.render(80);
    expect(before.length).toBeGreaterThan(0);
    expect(before.join("\n")).toContain("me");

    // Construct a decisions overlay on the same data the /decisions handler
    // would pass; the rail must not be touched by overlay lifecycle.
    const overlay = createDecisionsOverlayComponent({
      peers: [{ name: "worker-a", state: "running", decisionPending: false }],
      decisions: [],
      done: () => {},
    });
    expect(overlay.render(80).length).toBeGreaterThan(0);

    const after = rail.render(80);
    expect(after).toEqual(before);
  });
});
