import { describe, it, expect } from "vitest";
import { aggregateGroupMembership } from "./group-membership.mjs";

// Minimal shim types for test readability.
type NodeLike = { name?: string; groups?: string[]; [key: string]: unknown };
type TopoLike = { groups?: Record<string, string[]>; nodes: NodeLike[] };

// ── helpers ──────────────────────────────────────────────────────────────────

function topoOf(nodes: NodeLike[], groups?: Record<string, string[]>): TopoLike {
  return { nodes, ...(groups ? { groups } : {}) };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("aggregateGroupMembership", () => {
  // 1. Top-level groups only, no per-node groups
  it("returns top-level groups unchanged when no per-node groups are present", () => {
    const topo = topoOf(
      [
        { name: "w1", recipe: "mesh-node" },
        { name: "w2", recipe: "mesh-node" },
      ],
      { workers: ["w1", "w2"] },
    );
    const result = aggregateGroupMembership(topo);
    expect(result.get("workers")).toEqual(["w1", "w2"]);
    expect(result.size).toBe(1);
  });

  // 2. Per-node groups only, no top-level groups block
  it("builds groups entirely from per-node declarations when no top-level block", () => {
    const topo = topoOf([
      { name: "w1", groups: ["workers"] },
      { name: "w2", groups: ["workers"] },
    ]);
    const result = aggregateGroupMembership(topo);
    expect(result.get("workers")).toEqual(["w1", "w2"]);
  });

  // 3. Both forms for the same group — top-level first, then per-node order, no duplicates
  it("unions both forms for the same group with top-level members appearing first", () => {
    const topo = topoOf(
      [
        { name: "w3", groups: ["team"] },
        { name: "w1", groups: ["team"] }, // w1 is in top-level AND per-node
      ],
      { team: ["w1", "w2"] },
    );
    const result = aggregateGroupMembership(topo);
    // w1 and w2 from top-level, then w3 from per-node; w1 per-node is deduped
    expect(result.get("team")).toEqual(["w1", "w2", "w3"]);
  });

  // 4. Node belonging to multiple groups
  it("adds the node to every group it declares membership in", () => {
    const topo = topoOf([{ name: "multi", groups: ["alpha", "beta", "gamma"] }]);
    const result = aggregateGroupMembership(topo);
    expect(result.get("alpha")).toEqual(["multi"]);
    expect(result.get("beta")).toEqual(["multi"]);
    expect(result.get("gamma")).toEqual(["multi"]);
  });

  // 5. Empty group declared at top level but never joined
  it("preserves an empty top-level group entry", () => {
    const topo = topoOf([{ name: "w1" }], { empty: [] });
    const result = aggregateGroupMembership(topo);
    expect(result.has("empty")).toBe(true);
    expect(result.get("empty")).toEqual([]);
  });

  // 6. Per-node group referencing a group not declared at top-level is allowed (implicit)
  it("allows per-node groups to reference groups not declared in top-level block", () => {
    const topo = topoOf([{ name: "w1", groups: ["implicit-group"] }]);
    const result = aggregateGroupMembership(topo);
    expect(result.get("implicit-group")).toEqual(["w1"]);
  });

  // 7. Order preservation
  it("preserves declaration order within a group", () => {
    const topo = topoOf(
      [
        { name: "c", groups: ["ordered"] },
        { name: "b", groups: ["ordered"] },
        { name: "a", groups: ["ordered"] },
      ],
    );
    const result = aggregateGroupMembership(topo);
    expect(result.get("ordered")).toEqual(["c", "b", "a"]);
  });

  it("top-level declaration order is preserved before per-node additions", () => {
    const topo = topoOf(
      [{ name: "z", groups: ["letters"] }],
      { letters: ["a", "b", "c"] },
    );
    const result = aggregateGroupMembership(topo);
    expect(result.get("letters")).toEqual(["a", "b", "c", "z"]);
  });

  // 8. Anonymous nodes (no `name`) are silently skipped
  it("skips anonymous nodes (no name field) without error", () => {
    const topo = topoOf([
      { groups: ["workers"] }, // no name — should be ignored
      { name: "w1", groups: ["workers"] },
    ]);
    const result = aggregateGroupMembership(topo);
    expect(result.get("workers")).toEqual(["w1"]);
  });

  it("skips nodes with empty-string name", () => {
    const topo = topoOf([
      { name: "", groups: ["workers"] }, // empty string name — should be ignored
      { name: "w1", groups: ["workers"] },
    ]);
    const result = aggregateGroupMembership(topo);
    expect(result.get("workers")).toEqual(["w1"]);
  });

  // No-op edge cases
  it("returns an empty Map for a topology with no groups and no per-node groups", () => {
    const topo = topoOf([{ name: "solo" }]);
    const result = aggregateGroupMembership(topo);
    expect(result.size).toBe(0);
  });

  it("deduplicates members within a top-level group", () => {
    // Defensive: top-level block with a dup (shouldn't happen in normal parsing but be safe)
    const topo: TopoLike = {
      groups: { workers: ["w1", "w2", "w1"] } as Record<string, string[]>,
      nodes: [],
    };
    const result = aggregateGroupMembership(topo);
    expect(result.get("workers")).toEqual(["w1", "w2"]);
  });

  it("does not add a node to a group twice even if it appears in top-level and per-node", () => {
    const topo = topoOf(
      [{ name: "w1", groups: ["workers"] }],
      { workers: ["w1"] },
    );
    const result = aggregateGroupMembership(topo);
    expect(result.get("workers")).toEqual(["w1"]); // not ["w1", "w1"]
  });
});
