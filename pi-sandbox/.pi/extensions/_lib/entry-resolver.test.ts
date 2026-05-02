/**
 * entry-resolver.test.ts — hermetic unit tests for resolveEntry() and
 * crashAutoShiftTarget().
 *
 * Coverage:
 *   - entry == top supervisor (allowed)
 *   - entry differs from top supervisor (allowed)
 *   - missing entry caught
 *   - crash-auto-shift returns top supervisor name
 *   - group_binding supervisor resolution
 */

import { describe, it, expect } from "vitest";
import { resolveEntry, crashAutoShiftTarget } from "./entry-resolver.mjs";

// Inline types for test readability — the authoritative typedefs live in entry-resolver.mjs JSDoc.
type TopologyNode = {
  name: string;
  recipe?: string;
  type?: "relay";
  supervisor?: string;
  [key: string]: unknown;
};

type Topology = {
  entry?: string;
  groups?: Record<string, string[]>;
  group_bindings?: Record<string, { supervisor?: string; [key: string]: unknown }>;
  nodes: TopologyNode[];
};

// ── helpers ──────────────────────────────────────────────────────────────────

function authorityWorkerTopo(entryName?: string): Topology {
  return {
    entry: entryName,
    nodes: [
      { name: "authority", recipe: "mesh-authority" },
      { name: "worker", recipe: "mesh-node", supervisor: "authority" },
    ],
  };
}

// ── resolveEntry ──────────────────────────────────────────────────────────────

describe("resolveEntry", () => {
  it("entry == top supervisor is allowed", () => {
    const result = resolveEntry(authorityWorkerTopo("authority"));
    expect(result.errors).toHaveLength(0);
    expect(result.entryPeer).toBe("authority");
    expect(result.topSupervisor).toBe("authority");
  });

  it("entry differs from top supervisor is allowed", () => {
    const result = resolveEntry(authorityWorkerTopo("worker"));
    expect(result.errors).toHaveLength(0);
    expect(result.entryPeer).toBe("worker");
    expect(result.topSupervisor).toBe("authority");
  });

  it("missing entry is caught with an error", () => {
    const result = resolveEntry(authorityWorkerTopo(undefined));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /entry/i.test(e))).toBe(true);
    expect(result.entryPeer).toBeNull();
  });

  it("entry naming a non-existent peer is caught with an error", () => {
    const result = resolveEntry(authorityWorkerTopo("nobody"));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /nobody/i.test(e))).toBe(true);
    expect(result.entryPeer).toBeNull();
  });

  it("resolves top supervisor from group_bindings (node without per-node supervisor)", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { workers: ["w1", "w2"] },
      group_bindings: { workers: { supervisor: "authority" } },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node" },
        { name: "w2", recipe: "mesh-node" },
      ],
    };
    const result = resolveEntry(topo);
    expect(result.errors).toHaveLength(0);
    expect(result.topSupervisor).toBe("authority");
    expect(result.entryPeer).toBe("authority");
  });

  it("per-node supervisor overrides group_binding when computing top candidates", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { workers: ["w1"] },
      group_bindings: {
        workers: { supervisor: "authority" },
      },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        // w1 has per-node supervisor that overrides group_binding
        { name: "w1", recipe: "mesh-node", supervisor: "authority" },
      ],
    };
    const result = resolveEntry(topo);
    // authority is the only node with no effective supervisor
    expect(result.topSupervisor).toBe("authority");
    expect(result.errors).toHaveLength(0);
  });

  it("returns topSupervisor:null when no top candidate exists", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", supervisor: "external" },
        { name: "worker", recipe: "mesh-node", supervisor: "authority" },
      ],
    };
    const result = resolveEntry(topo);
    expect(result.topSupervisor).toBeNull();
  });

  it("returns topSupervisor:null when multiple top candidates exist", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "other-authority", recipe: "mesh-authority" }, // also no supervisor
        { name: "worker", recipe: "mesh-node", supervisor: "authority" },
      ],
    };
    const result = resolveEntry(topo);
    expect(result.topSupervisor).toBeNull();
  });

  it("relay nodes are excluded from top-supervisor candidates", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "human", type: "relay" }, // no supervisor, but relay — excluded
        { name: "worker", recipe: "mesh-node", supervisor: "authority" },
      ],
    };
    const result = resolveEntry(topo);
    // Only authority qualifies as top supervisor (human is relay, excluded)
    expect(result.topSupervisor).toBe("authority");
  });

  it("single-node topology has that node as both entry and top supervisor", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [{ name: "authority", recipe: "mesh-authority" }],
    };
    const result = resolveEntry(topo);
    expect(result.errors).toHaveLength(0);
    expect(result.entryPeer).toBe("authority");
    expect(result.topSupervisor).toBe("authority");
  });
});

// ── crashAutoShiftTarget ──────────────────────────────────────────────────────

describe("crashAutoShiftTarget", () => {
  it("returns the top supervisor name on crash auto-shift", () => {
    const target = crashAutoShiftTarget(authorityWorkerTopo("worker"));
    expect(target).toBe("authority");
  });

  it("returns top supervisor even when entry == top supervisor", () => {
    const target = crashAutoShiftTarget(authorityWorkerTopo("authority"));
    expect(target).toBe("authority");
  });

  it("returns null when no unique top supervisor can be resolved", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "rogue", recipe: "mesh-authority" },
        { name: "worker", recipe: "mesh-node", supervisor: "authority" },
      ],
    };
    const target = crashAutoShiftTarget(topo);
    expect(target).toBeNull();
  });

  it("resolves through group_bindings correctly", () => {
    const topo: Topology = {
      entry: "w1",
      groups: { workers: ["w1", "w2"] },
      group_bindings: { workers: { supervisor: "authority" } },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node" },
        { name: "w2", recipe: "mesh-node" },
      ],
    };
    const target = crashAutoShiftTarget(topo);
    expect(target).toBe("authority");
  });
});
