// cohort-tracker.test.ts — hermetic unit tests for the cohort tracker.
// No model calls, no network, no filesystem I/O.

import { describe, it, expect } from "vitest";
import type { GroupMap } from "./cohort-registry.js";
import {
  ingestMeshUpdate,
  expandGroupRef,
  lookupKnownPeer,
  needsLookup,
  getCohortLookupHook,
  installCohortLookupHook,
  defaultCohortLookupHook,
} from "./cohort-tracker.js";

function makeCache(): GroupMap {
  return new Map();
}

// ---------------------------------------------------------------------------
// ingestMeshUpdate
// ---------------------------------------------------------------------------

describe("ingestMeshUpdate", () => {
  it("op:add inserts peer into declared group", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, {
      spawner: "sp",
      changes: [{ peer: "p1", recipe: "writer", groups: ["team"], op: "add" }],
    });
    expect(cache.get("team")).toEqual([{ peer: "p1", recipe: "writer" }]);
  });

  it("op:add with no groups → _default", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, {
      spawner: "sp",
      changes: [{ peer: "p1", recipe: "writer", groups: [], op: "add" }],
    });
    expect(cache.get("_default")).toEqual([{ peer: "p1", recipe: "writer" }]);
  });

  it("op:remove removes peer from all groups", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, {
      spawner: "sp",
      changes: [{ peer: "p1", recipe: "writer", groups: ["a", "b"], op: "add" }],
    });
    ingestMeshUpdate(cache, {
      spawner: "sp",
      changes: [{ peer: "p1", recipe: "writer", groups: [], op: "remove" }],
    });
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(false);
  });

  it("deduplicates on repeated add", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, { spawner: "sp", changes: [{ peer: "p1", recipe: "r", groups: ["t"], op: "add" }] });
    ingestMeshUpdate(cache, { spawner: "sp", changes: [{ peer: "p1", recipe: "r", groups: ["t"], op: "add" }] });
    expect(cache.get("t")).toHaveLength(1);
  });

  it("multiple changes in one update processed in order", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, {
      spawner: "sp",
      changes: [
        { peer: "p1", recipe: "writer", groups: ["team"], op: "add" },
        { peer: "p2", recipe: "reviewer", groups: ["team"], op: "add" },
        { peer: "p1", recipe: "writer", groups: [], op: "remove" },
      ],
    });
    expect(cache.get("team")).toEqual([{ peer: "p2", recipe: "reviewer" }]);
  });

  it("pruning empty groups after remove", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, { spawner: "sp", changes: [{ peer: "p1", recipe: "r", groups: ["solo"], op: "add" }] });
    ingestMeshUpdate(cache, { spawner: "sp", changes: [{ peer: "p1", recipe: "r", groups: [], op: "remove" }] });
    expect(cache.has("solo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// expandGroupRef
// ---------------------------------------------------------------------------

describe("expandGroupRef", () => {
  it("literal ref → [literal]", () => {
    const cache = makeCache();
    expect(expandGroupRef(cache, [], "peer-a")).toEqual(["peer-a"]);
  });

  it("@<group> expands all peers in group", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, { spawner: "sp", changes: [
      { peer: "p1", recipe: "r", groups: ["team"], op: "add" },
      { peer: "p2", recipe: "r", groups: ["team"], op: "add" },
    ]});
    expect(expandGroupRef(cache, [], "@team")).toEqual(["p1", "p2"]);
  });

  it("@<group>:<recipe> filters by recipe", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, { spawner: "sp", changes: [
      { peer: "w1", recipe: "writer", groups: ["team"], op: "add" },
      { peer: "r1", recipe: "reviewer", groups: ["team"], op: "add" },
    ]});
    expect(expandGroupRef(cache, [], "@team:writer")).toEqual(["w1"]);
  });

  it("@$myGroups expands all peers in selfGroups", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, { spawner: "sp", changes: [
      { peer: "p1", recipe: "r", groups: ["haiku"], op: "add" },
      { peer: "p2", recipe: "r", groups: ["story"], op: "add" },
    ]});
    const result = expandGroupRef(cache, ["haiku"], "@$myGroups");
    expect(result).toEqual(["p1"]);
  });

  it("@$myGroups with empty selfGroups uses _default", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, { spawner: "sp", changes: [
      { peer: "p1", recipe: "r", groups: [], op: "add" },
    ]});
    expect(expandGroupRef(cache, [], "@$myGroups")).toEqual(["p1"]);
  });

  it("@$myGroups:<recipe> filters by recipe", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, { spawner: "sp", changes: [
      { peer: "w1", recipe: "writer", groups: ["haiku"], op: "add" },
      { peer: "r1", recipe: "reviewer", groups: ["haiku"], op: "add" },
    ]});
    expect(expandGroupRef(cache, ["haiku"], "@$myGroups:writer")).toEqual(["w1"]);
  });

  it("empty group returns []", () => {
    const cache = makeCache();
    expect(expandGroupRef(cache, [], "@nonexistent")).toEqual([]);
  });

  it("deduplicates peers across multiple selfGroups for @$myGroups", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, { spawner: "sp", changes: [
      { peer: "p1", recipe: "r", groups: ["g1"], op: "add" },
    ]});
    ingestMeshUpdate(cache, { spawner: "sp", changes: [
      { peer: "p1", recipe: "r", groups: ["g2"], op: "add" },
    ]});
    ingestMeshUpdate(cache, { spawner: "sp", changes: [
      { peer: "p2", recipe: "r", groups: ["g2"], op: "add" },
    ]});
    const result = expandGroupRef(cache, ["g1", "g2"], "@$myGroups");
    // p1 should appear only once
    expect(result).toEqual(["p1", "p2"]);
  });
});

// ---------------------------------------------------------------------------
// needsLookup
// ---------------------------------------------------------------------------

describe("needsLookup", () => {
  it("returns true for a peer not in the cache", () => {
    const cache = makeCache();
    expect(needsLookup(cache, "ghost")).toBe(true);
  });

  it("returns false for a peer present in the cache", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, { spawner: "sp", changes: [{ peer: "known", recipe: "r", groups: ["t"], op: "add" }] });
    expect(needsLookup(cache, "known")).toBe(false);
  });

  it("returns true again after peer is removed", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, { spawner: "sp", changes: [{ peer: "p1", recipe: "r", groups: ["t"], op: "add" }] });
    ingestMeshUpdate(cache, { spawner: "sp", changes: [{ peer: "p1", recipe: "r", groups: [], op: "remove" }] });
    expect(needsLookup(cache, "p1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lookupKnownPeer
// ---------------------------------------------------------------------------

describe("lookupKnownPeer", () => {
  it("returns undefined for unknown peer", () => {
    expect(lookupKnownPeer(makeCache(), "ghost")).toBeUndefined();
  });

  it("returns the member record when peer is found", () => {
    const cache = makeCache();
    ingestMeshUpdate(cache, { spawner: "sp", changes: [{ peer: "p1", recipe: "writer", groups: ["team"], op: "add" }] });
    expect(lookupKnownPeer(cache, "p1")).toEqual({ peer: "p1", recipe: "writer" });
  });
});

// ---------------------------------------------------------------------------
// __pi_cohort_lookup__ hook seam
// ---------------------------------------------------------------------------

describe("__pi_cohort_lookup__ hook seam", () => {
  it("defaultCohortLookupHook returns null for any peer", async () => {
    const result = await defaultCohortLookupHook("any-peer");
    expect(result).toBeNull();
  });

  it("getCohortLookupHook returns the no-op default when not installed", () => {
    // Remove any hook set by other tests
    delete (globalThis as Record<string, unknown>).__pi_cohort_lookup__;
    const hook = getCohortLookupHook();
    // Default hook returns null
    return hook("test").then((r) => expect(r).toBeNull());
  });

  it("installCohortLookupHook installs a custom hook reachable via getCohortLookupHook", async () => {
    const custom: import("./cohort-tracker.js").CohortLookupHook = async (name) => ({
      groups: ["team"],
      recipe: "writer",
    });
    installCohortLookupHook(custom);
    const hook = getCohortLookupHook();
    const result = await hook("any-peer");
    expect(result).toEqual({ groups: ["team"], recipe: "writer" });
    // Restore
    delete (globalThis as Record<string, unknown>).__pi_cohort_lookup__;
  });
});
