// cohort-registry.test.ts — hermetic unit tests for CohortRegistry.
// No model calls, no network, no filesystem I/O.

import { describe, it, expect } from "vitest";
import {
  addMember,
  removeMember,
  applyMeshUpdate,
  resolveCohortRef,
  type CohortRegistry,
  type MeshUpdate,
} from "./cohort-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReg(): CohortRegistry {
  return new Map();
}

// ---------------------------------------------------------------------------
// addMember
// ---------------------------------------------------------------------------

describe("addMember", () => {
  it("ungrouped peer joins _default implicitly", () => {
    const reg = makeReg();
    addMember(reg, "spawner-a", { peer: "p1", recipe: "writer" }, []);
    const gm = reg.get("spawner-a")!;
    expect(gm.get("_default")).toEqual([{ peer: "p1", recipe: "writer" }]);
  });

  it("explicit groups used, _default NOT added", () => {
    const reg = makeReg();
    addMember(reg, "spawner-a", { peer: "p1", recipe: "writer" }, ["haiku"]);
    const gm = reg.get("spawner-a")!;
    expect(gm.get("haiku")).toEqual([{ peer: "p1", recipe: "writer" }]);
    expect(gm.has("_default")).toBe(false);
  });

  it("peer in multiple groups", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, ["a", "b"]);
    const gm = reg.get("sp")!;
    expect(gm.get("a")).toEqual([{ peer: "p1", recipe: "r" }]);
    expect(gm.get("b")).toEqual([{ peer: "p1", recipe: "r" }]);
  });

  it("deduplicates peer within a group (insertion order preserved)", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, ["team"]);
    addMember(reg, "sp", { peer: "p2", recipe: "r" }, ["team"]);
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, ["team"]); // duplicate
    const gm = reg.get("sp")!;
    expect(gm.get("team")).toEqual([
      { peer: "p1", recipe: "r" },
      { peer: "p2", recipe: "r" },
    ]);
  });

  it("two spawners with the same group name get disjoint sets", () => {
    const reg = makeReg();
    addMember(reg, "sp-a", { peer: "x1", recipe: "r" }, ["team"]);
    addMember(reg, "sp-b", { peer: "y1", recipe: "r" }, ["team"]);
    expect(reg.get("sp-a")!.get("team")).toEqual([{ peer: "x1", recipe: "r" }]);
    expect(reg.get("sp-b")!.get("team")).toEqual([{ peer: "y1", recipe: "r" }]);
  });
});

// ---------------------------------------------------------------------------
// removeMember
// ---------------------------------------------------------------------------

describe("removeMember", () => {
  it("removes peer from all groups under a spawner", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, ["a", "b"]);
    addMember(reg, "sp", { peer: "p2", recipe: "r" }, ["a"]);
    removeMember(reg, "sp", "p1");
    const gm = reg.get("sp")!;
    expect(gm.get("a")).toEqual([{ peer: "p2", recipe: "r" }]);
    expect(gm.has("b")).toBe(false); // empty group pruned
  });

  it("is a no-op for unknown spawner", () => {
    const reg = makeReg();
    // Should not throw
    removeMember(reg, "nonexistent", "p1");
    expect(reg.size).toBe(0);
  });

  it("is a no-op for unknown peer under a known spawner", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, ["team"]);
    removeMember(reg, "sp", "ghost");
    expect(reg.get("sp")!.get("team")).toEqual([{ peer: "p1", recipe: "r" }]);
  });

  it("prunes empty groups after removal", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, ["solo"]);
    removeMember(reg, "sp", "p1");
    // spawner namespace should be pruned entirely
    expect(reg.has("sp")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyMeshUpdate
// ---------------------------------------------------------------------------

describe("applyMeshUpdate", () => {
  it("op:add calls addMember", () => {
    const reg = makeReg();
    const update: MeshUpdate = {
      spawner: "sp",
      changes: [{ peer: "p1", recipe: "r", groups: ["team"], op: "add" }],
    };
    applyMeshUpdate(reg, update);
    expect(reg.get("sp")!.get("team")).toEqual([{ peer: "p1", recipe: "r" }]);
  });

  it("op:remove calls removeMember", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, ["team"]);
    const update: MeshUpdate = {
      spawner: "sp",
      changes: [{ peer: "p1", recipe: "r", groups: ["team"], op: "remove" }],
    };
    applyMeshUpdate(reg, update);
    expect(reg.has("sp")).toBe(false);
  });

  it("processes multiple changes in order", () => {
    const reg = makeReg();
    const update: MeshUpdate = {
      spawner: "sp",
      changes: [
        { peer: "p1", recipe: "writer", groups: [], op: "add" },
        { peer: "p2", recipe: "reviewer", groups: ["review"], op: "add" },
        { peer: "p1", recipe: "writer", groups: [], op: "remove" },
      ],
    };
    applyMeshUpdate(reg, update);
    const gm = reg.get("sp")!;
    expect(gm.has("_default")).toBe(false); // p1 removed
    expect(gm.get("review")).toEqual([{ peer: "p2", recipe: "reviewer" }]);
  });
});

// ---------------------------------------------------------------------------
// resolveCohortRef — list fields (expand-all)
// ---------------------------------------------------------------------------

describe("resolveCohortRef — list fields", () => {
  it("literal pass-through for list field", () => {
    const reg = makeReg();
    const result = resolveCohortRef({ ref: "peer-a", registry: reg, spawnerName: "sp", resolverGroups: [], fieldKind: "list" });
    expect(result).toEqual(["peer-a"]);
  });

  it("@group expands all peers in group", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, ["team"]);
    addMember(reg, "sp", { peer: "p2", recipe: "r" }, ["team"]);
    const result = resolveCohortRef({ ref: "@team", registry: reg, spawnerName: "sp", resolverGroups: [], fieldKind: "list" });
    expect(result).toEqual(["p1", "p2"]);
  });

  it("@group:<recipe> intersects by recipe", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "w1", recipe: "writer" }, ["team"]);
    addMember(reg, "sp", { peer: "r1", recipe: "reviewer" }, ["team"]);
    const result = resolveCohortRef({ ref: "@team:writer", registry: reg, spawnerName: "sp", resolverGroups: [], fieldKind: "list" });
    expect(result).toEqual(["w1"]);
  });

  it("@$myGroups expands peers in resolver's own groups", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, ["haiku"]);
    addMember(reg, "sp", { peer: "p2", recipe: "r" }, ["story"]);
    addMember(reg, "sp", { peer: "p3", recipe: "r" }, ["haiku"]);
    // resolver belongs to ["haiku"]
    const result = resolveCohortRef({ ref: "@$myGroups", registry: reg, spawnerName: "sp", resolverGroups: ["haiku"], fieldKind: "list" });
    expect(result).toEqual(["p1", "p3"]);
  });

  it("@$myGroups:<recipe> intersects resolver's groups by recipe", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "w1", recipe: "writer" }, ["haiku"]);
    addMember(reg, "sp", { peer: "r1", recipe: "reviewer" }, ["haiku"]);
    const result = resolveCohortRef({ ref: "@$myGroups:writer", registry: reg, spawnerName: "sp", resolverGroups: ["haiku"], fieldKind: "list" });
    expect(result).toEqual(["w1"]);
  });

  it("ungrouped resolver uses _default for @$myGroups", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, []);
    addMember(reg, "sp", { peer: "p2", recipe: "r" }, []);
    const result = resolveCohortRef({ ref: "@$myGroups", registry: reg, spawnerName: "sp", resolverGroups: [], fieldKind: "list" });
    expect(result).toEqual(["p1", "p2"]);
  });

  it("unknown group returns [] for list field", () => {
    const reg = makeReg();
    const result = resolveCohortRef({ ref: "@nonexistent", registry: reg, spawnerName: "sp", resolverGroups: [], fieldKind: "list" });
    expect(result).toEqual([]);
  });

  it("empty group returns [] for list field", () => {
    const reg = makeReg();
    // No members added
    const result = resolveCohortRef({ ref: "@empty-group", registry: reg, spawnerName: "sp", resolverGroups: [], fieldKind: "list" });
    expect(result).toEqual([]);
  });

  it("scoped to spawner: different spawner with same group returns []", () => {
    const reg = makeReg();
    addMember(reg, "sp-other", { peer: "p1", recipe: "r" }, ["team"]);
    // Resolving in sp-mine should not see sp-other's members
    const result = resolveCohortRef({ ref: "@team", registry: reg, spawnerName: "sp-mine", resolverGroups: [], fieldKind: "list" });
    expect(result).toEqual([]);
  });

  it("deduplicates members across groups for @$myGroups", () => {
    const reg = makeReg();
    // p1 belongs to both groups
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, ["g1"]);
    addMember(reg, "sp", { peer: "p1", recipe: "r" }, ["g2"]);
    addMember(reg, "sp", { peer: "p2", recipe: "r" }, ["g2"]);
    const result = resolveCohortRef({ ref: "@$myGroups", registry: reg, spawnerName: "sp", resolverGroups: ["g1", "g2"], fieldKind: "list" });
    // p1 appears only once
    expect(result).toEqual(["p1", "p2"]);
  });
});

// ---------------------------------------------------------------------------
// resolveCohortRef — singular fields (round-robin)
// ---------------------------------------------------------------------------

describe("resolveCohortRef — singular fields", () => {
  it("literal pass-through for singular field", () => {
    const reg = makeReg();
    const result = resolveCohortRef({ ref: "peer-a", registry: reg, spawnerName: "sp", resolverGroups: [], fieldKind: "singular" });
    expect(result).toBe("peer-a");
  });

  it("round-robin stickiness: counter advances across calls", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "r1", recipe: "reviewer" }, ["review"]);
    addMember(reg, "sp", { peer: "r2", recipe: "reviewer" }, ["review"]);
    addMember(reg, "sp", { peer: "r3", recipe: "reviewer" }, ["review"]);
    const counter = { value: 0 };
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(resolveCohortRef({ ref: "@review", registry: reg, spawnerName: "sp", resolverGroups: [], fieldKind: "singular", counterState: counter }));
    }
    expect(results).toEqual(["r1", "r2", "r3", "r1", "r2"]);
  });

  it("empty group at singular resolution throws", () => {
    const reg = makeReg();
    const counter = { value: 0 };
    expect(() =>
      resolveCohortRef({ ref: "@empty", registry: reg, spawnerName: "sp", resolverGroups: [], fieldKind: "singular", counterState: counter }),
    ).toThrow(/singular|spawn time|zero members/i);
  });

  it("recipe-typed intersection for singular field", () => {
    const reg = makeReg();
    addMember(reg, "sp", { peer: "w1", recipe: "writer" }, ["team"]);
    addMember(reg, "sp", { peer: "r1", recipe: "reviewer" }, ["team"]);
    const counter = { value: 0 };
    const result = resolveCohortRef({ ref: "@team:reviewer", registry: reg, spawnerName: "sp", resolverGroups: [], fieldKind: "singular", counterState: counter });
    expect(result).toBe("r1");
  });
});
