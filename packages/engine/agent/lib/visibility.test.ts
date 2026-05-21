// visibility.test.ts — hermetic unit tests for canSee / visiblePeers.
// No I/O, no network, no model calls.

import { describe, it, expect } from "vitest";
import { canSee, visiblePeers, type PeerNode } from "./visibility.js";

// ---------------------------------------------------------------------------
// canSee
// ---------------------------------------------------------------------------

describe("canSee", () => {
  // ── Spawner↔child structural edge ──────────────────────────────────────

  it("X spawned Y → X can see Y regardless of groups", () => {
    const x: PeerNode = { name: "host", spawner: undefined, groups: [] };
    const y: PeerNode = { name: "worker", spawner: "host", groups: ["special"] };
    expect(canSee(x, y)).toBe(true);
  });

  it("Y spawned X → X can see Y regardless of groups", () => {
    const x: PeerNode = { name: "worker", spawner: "host", groups: [] };
    const y: PeerNode = { name: "host", spawner: undefined, groups: [] };
    expect(canSee(x, y)).toBe(true);
  });

  it("spawner edge is bidirectional: canSee(host, worker) AND canSee(worker, host)", () => {
    const host: PeerNode = { name: "host", spawner: undefined, groups: [] };
    const worker: PeerNode = { name: "worker", spawner: "host", groups: [] };
    expect(canSee(host, worker)).toBe(true);
    expect(canSee(worker, host)).toBe(true);
  });

  // ── Same spawner + shared group → visible ──────────────────────────────

  it("same spawner + shared explicit group → visible", () => {
    const p1: PeerNode = { name: "p1", spawner: "host", groups: ["haiku"] };
    const p2: PeerNode = { name: "p2", spawner: "host", groups: ["haiku"] };
    expect(canSee(p1, p2)).toBe(true);
  });

  it("same spawner + no groups (both ungrouped) → visible via _default", () => {
    const p1: PeerNode = { name: "p1", spawner: "host", groups: [] };
    const p2: PeerNode = { name: "p2", spawner: "host", groups: [] };
    expect(canSee(p1, p2)).toBe(true);
  });

  it("same spawner + one ungrouped, one with explicit group → NOT visible (_default ≠ explicit)", () => {
    const p1: PeerNode = { name: "p1", spawner: "host", groups: [] };       // effective: _default
    const p2: PeerNode = { name: "p2", spawner: "host", groups: ["haiku"] }; // effective: haiku
    expect(canSee(p1, p2)).toBe(false);
  });

  it("same spawner + disjoint explicit groups → NOT visible", () => {
    const p1: PeerNode = { name: "p1", spawner: "host", groups: ["haiku"] };
    const p2: PeerNode = { name: "p2", spawner: "host", groups: ["story"] };
    expect(canSee(p1, p2)).toBe(false);
  });

  // ── Overlapping multi-group → visible ──────────────────────────────────

  it("same spawner + overlapping multi-group → visible", () => {
    const p1: PeerNode = { name: "p1", spawner: "host", groups: ["haiku", "review"] };
    const p2: PeerNode = { name: "p2", spawner: "host", groups: ["review", "story"] };
    expect(canSee(p1, p2)).toBe(true);
  });

  // ── Cross-spawner → never visible ──────────────────────────────────────

  it("different spawners, same group name → NOT visible", () => {
    const p1: PeerNode = { name: "p1", spawner: "host-a", groups: ["team"] };
    const p2: PeerNode = { name: "p2", spawner: "host-b", groups: ["team"] };
    expect(canSee(p1, p2)).toBe(false);
  });

  it("different spawners, no groups → NOT visible (cross-spawner _default is isolated)", () => {
    const p1: PeerNode = { name: "p1", spawner: "host-a", groups: [] };
    const p2: PeerNode = { name: "p2", spawner: "host-b", groups: [] };
    expect(canSee(p1, p2)).toBe(false);
  });

  it("one peer has no spawner set — no structural or group link → NOT visible", () => {
    const p1: PeerNode = { name: "p1", spawner: undefined, groups: ["team"] };
    const p2: PeerNode = { name: "p2", spawner: undefined, groups: ["team"] };
    expect(canSee(p1, p2)).toBe(false);
  });

  // ── Self visibility is not tested (visiblePeers excludes self) ─────────
});

// ---------------------------------------------------------------------------
// visiblePeers
// ---------------------------------------------------------------------------

describe("visiblePeers", () => {
  it("returns empty for a solo peer", () => {
    const self: PeerNode = { name: "solo", spawner: undefined, groups: [] };
    expect(visiblePeers(self, [self])).toEqual([]);
  });

  it("excludes self from results", () => {
    const self: PeerNode = { name: "p1", spawner: "host", groups: [] };
    const sibling: PeerNode = { name: "p2", spawner: "host", groups: [] };
    const result = visiblePeers(self, [self, sibling]);
    expect(result).not.toContain(self);
    expect(result).toContain(sibling);
  });

  it("same-spawner + shared group → all returned", () => {
    const host: PeerNode = { name: "host", spawner: undefined, groups: [] };
    const w1: PeerNode = { name: "w1", spawner: "host", groups: ["team"] };
    const w2: PeerNode = { name: "w2", spawner: "host", groups: ["team"] };
    const w3: PeerNode = { name: "w3", spawner: "host", groups: ["other"] };
    const visible = visiblePeers(w1, [host, w1, w2, w3]);
    // w1 can see: host (structural), w2 (shared group)
    // w1 cannot see w3 (disjoint group, same spawner)
    expect(visible.map((p) => p.name).sort()).toEqual(["host", "w2"]);
  });

  it("cross-spawner peers not returned", () => {
    const p1: PeerNode = { name: "p1", spawner: "host-a", groups: ["team"] };
    const p2: PeerNode = { name: "p2", spawner: "host-b", groups: ["team"] };
    const visible = visiblePeers(p1, [p1, p2]);
    expect(visible).toEqual([]);
  });

  it("spawner sees all its direct children regardless of their groups", () => {
    const host: PeerNode = { name: "host", spawner: undefined, groups: [] };
    const w1: PeerNode = { name: "w1", spawner: "host", groups: ["a"] };
    const w2: PeerNode = { name: "w2", spawner: "host", groups: ["b"] };
    const visible = visiblePeers(host, [host, w1, w2]);
    expect(visible.map((p) => p.name).sort()).toEqual(["w1", "w2"]);
  });
});
