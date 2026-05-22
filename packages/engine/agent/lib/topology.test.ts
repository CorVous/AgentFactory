/**
 * topology.test.ts — engine-side tests for the canonical topology.mjs copy.
 * Near-copy of pi-sandbox/.pi/extensions/_lib/topology.test.ts, repointed
 * at ../lib/topology.mjs.
 */
import { describe, it, expect } from "vitest";
import { parseTopology, resolveNode } from "./topology.mjs";

// ── parseTopology ────────────────────────────────────────────────────────────

describe("parseTopology", () => {
  it("parses a minimal topology with one node", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    expect(topo.nodes).toHaveLength(1);
    expect(topo.nodes[0].name).toBe("worker");
    expect(topo.nodes[0].recipe).toBe("mesh-node");
  });

  it("parses bus_root, groups, and group_bindings", () => {
    const yaml = `
bus_root: /tmp/test-bus
groups:
  workers: [worker-a, worker-b]
group_bindings:
  workers:
    escalatesTo: authority
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker-a
    recipe: mesh-node
  - name: worker-b
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    expect(topo.bus_root).toBe("/tmp/test-bus");
    expect(topo.groups).toEqual({ workers: ["worker-a", "worker-b"] });
    expect(topo.group_bindings?.workers?.escalatesTo).toBe("authority");
    expect(topo.nodes).toHaveLength(3);
  });

  it("parses per-node Habitat overlay fields", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
    escalatesTo: authority
    submitsWorkTo: collector
    acceptsWorkFrom: [planner]
    messagesWith: [analyst]
`;
    const topo = parseTopology(yaml);
    const n = topo.nodes[0];
    expect(n.escalatesTo).toBe("authority");
    expect(n.submitsWorkTo).toBe("collector");
    expect(n.acceptsWorkFrom).toEqual(["planner"]);
    expect(n.messagesWith).toEqual(["analyst"]);
  });

  it("rejects YAML that is not a mapping", () => {
    expect(() => parseTopology("- a\n- b")).toThrow(/YAML must be a mapping/);
  });

  it("rejects a topology with empty nodes array", () => {
    expect(() => parseTopology("nodes: []")).toThrow(/non-empty array/);
  });

  it("rejects a topology with no nodes field", () => {
    expect(() => parseTopology("bus_root: /tmp/x")).toThrow(/non-empty array/);
  });

  it("rejects duplicate named nodes", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
  - name: worker
    recipe: mesh-node
`;
    expect(() => parseTopology(yaml)).toThrow(/duplicate node name/);
  });

  it("parses per-node groups field", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
    groups: [research, drafting]
`;
    const topo = parseTopology(yaml);
    expect(topo.nodes[0].groups).toEqual(["research", "drafting"]);
  });
});

// ── resolveNode ───────────────────────────────────────────────────────────────

describe("resolveNode", () => {
  it("returns empty peer arrays for a node with no overlay fields", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const result = resolveNode(topo, "worker");
    expect(result.acceptsWorkFrom).toEqual([]);
    expect(result.messagesWith).toEqual([]);
    expect(result.escalatesTo).toBeUndefined();
    expect(result.submitsWorkTo).toBeUndefined();
  });

  it("resolves per-node overlay fields", () => {
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker
    recipe: mesh-node
    escalatesTo: authority
    submitsWorkTo: authority
    acceptsWorkFrom: [authority]
    messagesWith: [authority]
`;
    const topo = parseTopology(yaml);
    const result = resolveNode(topo, "worker");
    expect(result.escalatesTo).toBe("authority");
    expect(result.submitsWorkTo).toBe("authority");
    expect(result.acceptsWorkFrom).toEqual(["authority"]);
    expect(result.messagesWith).toEqual(["authority"]);
  });

  it("resolves group_bindings for a grouped node", () => {
    const yaml = `
groups:
  workers: [worker-a, worker-b]
group_bindings:
  workers:
    escalatesTo: authority
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker-a
    recipe: mesh-node
  - name: worker-b
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const result = resolveNode(topo, "worker-a");
    expect(result.escalatesTo).toBe("authority");
  });

  it("resolves @group ref in escalatesTo using round-robin", () => {
    const yaml = `
groups:
  reviewers: [r1, r2]
nodes:
  - name: r1
    recipe: mesh-authority
  - name: r2
    recipe: mesh-authority
  - name: worker
    recipe: mesh-node
    escalatesTo: "@reviewers"
`;
    const topo = parseTopology(yaml);
    const counters = new Map();
    const result = resolveNode(topo, "worker", counters);
    expect(["r1", "r2"]).toContain(result.escalatesTo);
  });

  it("throws when node is not found", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "nonexistent")).toThrow(/not found/);
  });

  it("throws when acceptsWorkFrom references an unknown node", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
    acceptsWorkFrom: [unknown-peer]
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "worker")).toThrow(/unknown node/);
  });
});
