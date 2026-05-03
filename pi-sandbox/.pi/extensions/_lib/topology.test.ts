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
    supervisor: authority
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
    expect(topo.group_bindings?.workers?.supervisor).toBe("authority");
    expect(topo.nodes).toHaveLength(3);
  });

  it("parses per-node Habitat overlay fields", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
    supervisor: authority
    submitTo: collector
    acceptedFrom: [planner]
    peers: [analyst]
`;
    const topo = parseTopology(yaml);
    const node = topo.nodes[0];
    expect(node.supervisor).toBe("authority");
    expect(node.submitTo).toBe("collector");
    expect(node.acceptedFrom).toEqual(["planner"]);
    expect(node.peers).toEqual(["analyst"]);
  });

  it("rejects duplicate node names", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
  - name: worker
    recipe: mesh-node
`;
    expect(() => parseTopology(yaml)).toThrow(/duplicate node name/i);
  });

  it("rejects missing nodes array", () => {
    expect(() => parseTopology("bus_root: /tmp/x\n")).toThrow(/nodes/i);
  });

  it("rejects empty nodes array", () => {
    expect(() => parseTopology("nodes: []\n")).toThrow(/nodes/i);
  });

  it("accepts a node without 'name' (the launcher auto-assigns one)", () => {
    const yaml = `
nodes:
  - recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    expect(topo.nodes).toHaveLength(1);
    expect(topo.nodes[0].name).toBeUndefined();
    expect(topo.nodes[0].recipe).toBe("mesh-node");
  });

  it("accepts a mix of named and unnamed nodes", () => {
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
  - recipe: mesh-node
  - recipe: mesh-node
    supervisor: authority
`;
    const topo = parseTopology(yaml);
    expect(topo.nodes).toHaveLength(3);
    expect(topo.nodes[0].name).toBe("authority");
    expect(topo.nodes[1].name).toBeUndefined();
    expect(topo.nodes[2].name).toBeUndefined();
    expect(topo.nodes[2].supervisor).toBe("authority");
  });

  it("still rejects duplicate names among named nodes when unnamed nodes are also present", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
  - recipe: mesh-node
  - name: worker
    recipe: mesh-node
`;
    expect(() => parseTopology(yaml)).toThrow(/duplicate node name/i);
  });

  it("accepts per-node groups field as an array of strings", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
    groups: [workers, submitters]
`;
    const topo = parseTopology(yaml);
    expect(topo.nodes[0].groups).toEqual(["workers", "submitters"]);
  });

  it("omits groups field when not supplied on a node", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    expect(topo.nodes[0].groups).toBeUndefined();
  });

  it("accepts a mix of named nodes with and without per-node groups", () => {
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker-a
    recipe: mesh-node
    groups: [workers]
  - name: worker-b
    recipe: mesh-node
    groups: [workers]
`;
    const topo = parseTopology(yaml);
    expect(topo.nodes[0].groups).toBeUndefined();
    expect(topo.nodes[1].groups).toEqual(["workers"]);
    expect(topo.nodes[2].groups).toEqual(["workers"]);
  });
});

// ── resolveNode ──────────────────────────────────────────────────────────────

describe("resolveNode", () => {
  it("returns empty arrays for a node with no peer fields", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
  - name: other
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "worker");
    expect(resolved.acceptedFrom).toEqual([]);
    expect(resolved.peers).toEqual([]);
    expect(resolved.supervisor).toBeUndefined();
    expect(resolved.submitTo).toBeUndefined();
  });

  it("returns per-node overlay fields verbatim when no group refs", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
    supervisor: authority
    submitTo: collector
    acceptedFrom: [planner]
    peers: [analyst]
  - name: authority
    recipe: mesh-authority
  - name: collector
    recipe: mesh-node
  - name: planner
    recipe: mesh-node
  - name: analyst
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "worker");
    expect(resolved.supervisor).toBe("authority");
    expect(resolved.submitTo).toBe("collector");
    expect(resolved.acceptedFrom).toEqual(["planner"]);
    expect(resolved.peers).toEqual(["analyst"]);
  });

  it("expands @group refs in peers", () => {
    const yaml = `
groups:
  team: [alice, bob]
nodes:
  - name: planner
    recipe: mesh-authority
    peers: ["@team"]
  - name: alice
    recipe: mesh-node
  - name: bob
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "planner");
    expect(resolved.peers).toEqual(["alice", "bob"]);
  });

  it("expands @group refs in acceptedFrom", () => {
    const yaml = `
groups:
  workers: [w1, w2, w3]
nodes:
  - name: authority
    recipe: mesh-authority
    acceptedFrom: ["@workers"]
  - name: w1
    recipe: mesh-node
  - name: w2
    recipe: mesh-node
  - name: w3
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "authority");
    expect(resolved.acceptedFrom).toEqual(["w1", "w2", "w3"]);
  });

  it("expands mixed literal + @group refs", () => {
    const yaml = `
groups:
  workers: [w1, w2]
nodes:
  - name: authority
    recipe: mesh-authority
    peers: [extra, "@workers"]
  - name: extra
    recipe: mesh-node
  - name: w1
    recipe: mesh-node
  - name: w2
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "authority");
    expect(resolved.peers).toEqual(["extra", "w1", "w2"]);
  });

  it("applies group_bindings to members — supervisor field", () => {
    const yaml = `
groups:
  workers: [w1, w2]
group_bindings:
  workers:
    supervisor: authority
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
  - name: w2
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    expect(resolveNode(topo, "w1").supervisor).toBe("authority");
    expect(resolveNode(topo, "w2").supervisor).toBe("authority");
    expect(resolveNode(topo, "authority").supervisor).toBeUndefined();
  });

  it("applies group_bindings — submitTo and peers fields", () => {
    const yaml = `
groups:
  workers: [w1, w2]
group_bindings:
  workers:
    submitTo: collector
    peers: [authority]
nodes:
  - name: w1
    recipe: mesh-node
  - name: w2
    recipe: mesh-node
  - name: collector
    recipe: mesh-node
  - name: authority
    recipe: mesh-authority
`;
    const topo = parseTopology(yaml);
    const w1 = resolveNode(topo, "w1");
    expect(w1.submitTo).toBe("collector");
    expect(w1.peers).toEqual(["authority"]);
  });

  it("per-node overrides win over group_bindings", () => {
    const yaml = `
groups:
  workers: [w1]
group_bindings:
  workers:
    supervisor: default-authority
    peers: [analyst]
nodes:
  - name: w1
    recipe: mesh-node
    supervisor: special-authority
    peers: [writer]
  - name: default-authority
    recipe: mesh-authority
  - name: special-authority
    recipe: mesh-authority
  - name: analyst
    recipe: mesh-node
  - name: writer
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "w1");
    expect(resolved.supervisor).toBe("special-authority");
    expect(resolved.peers).toEqual(["writer"]);
  });

  it("group_bindings can contain @group refs that get expanded", () => {
    const yaml = `
groups:
  workers: [w1, w2]
  reviewers: [r1, r2]
group_bindings:
  workers:
    peers: ["@reviewers"]
nodes:
  - name: w1
    recipe: mesh-node
  - name: w2
    recipe: mesh-node
  - name: r1
    recipe: mesh-node
  - name: r2
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    expect(resolveNode(topo, "w1").peers).toEqual(["r1", "r2"]);
    expect(resolveNode(topo, "w2").peers).toEqual(["r1", "r2"]);
  });

  it("node in multiple groups picks up all applicable bindings", () => {
    const yaml = `
groups:
  workers: [w1]
  submitters: [w1]
group_bindings:
  workers:
    supervisor: authority
  submitters:
    submitTo: collector
nodes:
  - name: w1
    recipe: mesh-node
  - name: authority
    recipe: mesh-authority
  - name: collector
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "w1");
    expect(resolved.supervisor).toBe("authority");
    expect(resolved.submitTo).toBe("collector");
  });

  // ── Rejection cases ──────────────────────────────────────────────────────

  it("rejects @group ref to undefined group", () => {
    const yaml = `
nodes:
  - name: planner
    recipe: mesh-authority
    peers: ["@nonexistent"]
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "planner")).toThrow(/group.*nonexistent/i);
  });

  it("rejects @group ref in group_bindings to undefined group", () => {
    const yaml = `
groups:
  workers: [w1]
group_bindings:
  workers:
    peers: ["@missing"]
nodes:
  - name: w1
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "w1")).toThrow(/group.*missing/i);
  });

  it("rejects acceptedFrom that references a non-existent node (after expansion)", () => {
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
    acceptedFrom: [phantom]
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "authority")).toThrow(/node.*phantom/i);
  });

  it("rejects peers that references a non-existent node (after expansion)", () => {
    const yaml = `
nodes:
  - name: planner
    recipe: mesh-authority
    peers: [ghost]
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "planner")).toThrow(/node.*ghost/i);
  });

  it("rejects resolveNode for a name not in the topology", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "nobody")).toThrow(/nobody/i);
  });

  // ── Per-node groups: field ───────────────────────────────────────────────

  it("per-node groups causes @group ref to expand to that node's name", () => {
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
    acceptedFrom: ["@workers"]
  - name: w1
    recipe: mesh-node
    groups: [workers]
  - name: w2
    recipe: mesh-node
    groups: [workers]
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "authority");
    expect(resolved.acceptedFrom).toEqual(["w1", "w2"]);
  });

  it("per-node groups can reference a group not declared at top level (implicit group)", () => {
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
    peers: ["@implicit"]
  - name: anon-worker
    recipe: mesh-node
    groups: [implicit]
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "authority");
    expect(resolved.peers).toEqual(["anon-worker"]);
  });

  it("mixes top-level and per-node groups for the same group name", () => {
    const yaml = `
groups:
  workers: [w1]
nodes:
  - name: authority
    recipe: mesh-authority
    acceptedFrom: ["@workers"]
  - name: w1
    recipe: mesh-node
  - name: w2
    recipe: mesh-node
    groups: [workers]
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "authority");
    // top-level w1 first, then per-node w2
    expect(resolved.acceptedFrom).toEqual(["w1", "w2"]);
  });

  it("per-node groups triggers group_binding for that node", () => {
    const yaml = `
group_bindings:
  workers:
    supervisor: authority
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    groups: [workers]
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "w1");
    expect(resolved.supervisor).toBe("authority");
  });

  it("anonymous node with groups field does not expand into @group refs (skipped)", () => {
    // After auto-naming the anonymous node gets a name; before that, it's skipped.
    // We test with the raw (pre-auto-naming) topology where the node has no name.
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
    acceptedFrom: ["@workers"]
  - recipe: mesh-node
    supervisor: authority
`;
    // The anonymous node has no `groups:` field; @workers ref should fail.
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "authority")).toThrow(/group.*workers/i);
  });

  it("anonymous node stamped with a name + groups participates in @group expansion", () => {
    // Simulate the launcher's auto-naming step: assign a name to the unnamed node
    // before calling resolveNode so the aggregator picks it up.
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
    acceptedFrom: ["@workers"]
  - recipe: mesh-node
    supervisor: authority
    groups: [workers]
`;
    const topo = parseTopology(yaml);
    // Simulate launcher auto-naming
    topo.nodes[1].name = "cottontail-worker";
    const resolved = resolveNode(topo, "authority");
    expect(resolved.acceptedFrom).toEqual(["cottontail-worker"]);
  });
});
