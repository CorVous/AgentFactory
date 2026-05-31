// group-membership.test.ts — hermetic unit tests for the engine canonical copy.
// Imports from the canonical engine location.

import { describe, it, expect } from "vitest";
import { aggregateGroupMembership, buildGroupMap, type GroupMapEntry } from "./group-membership.js";

// ---------------------------------------------------------------------------
// aggregateGroupMembership (legacy topology-shaped builder)
// ---------------------------------------------------------------------------

describe("aggregateGroupMembership", () => {
  it("returns an empty Map for an empty topology", () => {
    const result = aggregateGroupMembership({ nodes: [] });
    expect(result.size).toBe(0);
  });

  it("seeds from top-level groups block preserving order", () => {
    const result = aggregateGroupMembership({
      groups: { reviewers: ["r1", "r2"], writers: ["w1"] },
      nodes: [],
    });
    expect(result.get("reviewers")).toEqual(["r1", "r2"]);
    expect(result.get("writers")).toEqual(["w1"]);
  });

  it("appends per-node memberships to top-level groups", () => {
    const result = aggregateGroupMembership({
      groups: { reviewers: ["r1"] },
      nodes: [{ name: "r2", groups: ["reviewers"] }],
    });
    expect(result.get("reviewers")).toEqual(["r1", "r2"]);
  });

  it("creates a group implicitly from per-node declaration when not in top-level", () => {
    const result = aggregateGroupMembership({
      nodes: [{ name: "w1", groups: ["writers"] }],
    });
    expect(result.get("writers")).toEqual(["w1"]);
  });

  it("deduplicates members (top-level wins, per-node skipped if already present)", () => {
    const result = aggregateGroupMembership({
      groups: { team: ["a", "b"] },
      nodes: [{ name: "a", groups: ["team"] }],
    });
    expect(result.get("team")).toEqual(["a", "b"]);
  });

  it("skips anonymous nodes (no name)", () => {
    const result = aggregateGroupMembership({
      nodes: [{ groups: ["team"] }],
    });
    expect(result.size).toBe(0);
  });

  it("skips nodes with empty groups list", () => {
    const result = aggregateGroupMembership({
      nodes: [{ name: "n1", groups: [] }],
    });
    expect(result.size).toBe(0);
  });

  it("multiple nodes in declaration order", () => {
    const result = aggregateGroupMembership({
      nodes: [
        { name: "w1", groups: ["workers"] },
        { name: "w2", groups: ["workers"] },
        { name: "w3", groups: ["workers"] },
      ],
    });
    expect(result.get("workers")).toEqual(["w1", "w2", "w3"]);
  });

  it("a node can belong to multiple groups", () => {
    const result = aggregateGroupMembership({
      nodes: [{ name: "hybrid", groups: ["team-a", "team-b"] }],
    });
    expect(result.get("team-a")).toEqual(["hybrid"]);
    expect(result.get("team-b")).toEqual(["hybrid"]);
  });

  it("ignores non-array or non-string members in top-level groups", () => {
    const result = aggregateGroupMembership({
      groups: {
        valid: ["m1", "m2"],
        // @ts-expect-error — testing invalid input
        broken: "not-an-array",
      },
      nodes: [],
    });
    expect(result.get("valid")).toEqual(["m1", "m2"]);
    expect(result.has("broken")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildGroupMap (spawner-scoped builder)
// ---------------------------------------------------------------------------

describe("buildGroupMap", () => {
  it("empty entries → empty map", () => {
    const m = buildGroupMap([]);
    expect(m.size).toBe(0);
  });

  it("ungrouped peer joins _default implicitly", () => {
    const m = buildGroupMap([{ peer: "p1", groups: [] }]);
    expect(m.get("_default")).toEqual(["p1"]);
  });

  it("explicit groups used; _default NOT added", () => {
    const m = buildGroupMap([{ peer: "p1", groups: ["haiku"] }]);
    expect(m.get("haiku")).toEqual(["p1"]);
    expect(m.has("_default")).toBe(false);
  });

  it("peer in multiple groups", () => {
    const m = buildGroupMap([{ peer: "p1", groups: ["a", "b"] }]);
    expect(m.get("a")).toEqual(["p1"]);
    expect(m.get("b")).toEqual(["p1"]);
  });

  it("deduplicate peers within a group (insertion order preserved)", () => {
    const entries: GroupMapEntry[] = [
      { peer: "p1", groups: ["team"] },
      { peer: "p2", groups: ["team"] },
      { peer: "p1", groups: ["team"] }, // duplicate
    ];
    const m = buildGroupMap(entries);
    expect(m.get("team")).toEqual(["p1", "p2"]);
  });

  it("multiple peers with different groups end up in distinct groups", () => {
    const m = buildGroupMap([
      { peer: "p1", groups: ["a"] },
      { peer: "p2", groups: ["b"] },
    ]);
    expect(m.get("a")).toEqual(["p1"]);
    expect(m.get("b")).toEqual(["p2"]);
  });

  it("mix of grouped and ungrouped peers", () => {
    const m = buildGroupMap([
      { peer: "p1", groups: [] },
      { peer: "p2", groups: ["haiku"] },
    ]);
    expect(m.get("_default")).toEqual(["p1"]);
    expect(m.get("haiku")).toEqual(["p2"]);
  });
});
