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
    const node = topo.nodes[0];
    expect(node.escalatesTo).toBe("authority");
    expect(node.submitsWorkTo).toBe("collector");
    expect(node.acceptsWorkFrom).toEqual(["planner"]);
    expect(node.messagesWith).toEqual(["analyst"]);
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
    escalatesTo: authority
`;
    const topo = parseTopology(yaml);
    expect(topo.nodes).toHaveLength(3);
    expect(topo.nodes[0].name).toBe("authority");
    expect(topo.nodes[1].name).toBeUndefined();
    expect(topo.nodes[2].name).toBeUndefined();
    expect(topo.nodes[2].escalatesTo).toBe("authority");
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
    expect(resolved.acceptsWorkFrom).toEqual([]);
    expect(resolved.messagesWith).toEqual([]);
    expect(resolved.escalatesTo).toBeUndefined();
    expect(resolved.submitsWorkTo).toBeUndefined();
  });

  it("returns per-node overlay fields verbatim when no group refs", () => {
    const yaml = `
nodes:
  - name: worker
    recipe: mesh-node
    escalatesTo: authority
    submitsWorkTo: collector
    acceptsWorkFrom: [planner]
    messagesWith: [analyst]
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
    expect(resolved.escalatesTo).toBe("authority");
    expect(resolved.submitsWorkTo).toBe("collector");
    expect(resolved.acceptsWorkFrom).toEqual(["planner"]);
    expect(resolved.messagesWith).toEqual(["analyst"]);
  });

  it("expands @group refs in messagesWith", () => {
    const yaml = `
groups:
  team: [alice, bob]
nodes:
  - name: planner
    recipe: mesh-authority
    messagesWith: ["@team"]
  - name: alice
    recipe: mesh-node
  - name: bob
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "planner");
    expect(resolved.messagesWith).toEqual(["alice", "bob"]);
  });

  it("expands @group refs in acceptsWorkFrom", () => {
    const yaml = `
groups:
  workers: [w1, w2, w3]
nodes:
  - name: authority
    recipe: mesh-authority
    acceptsWorkFrom: ["@workers"]
  - name: w1
    recipe: mesh-node
  - name: w2
    recipe: mesh-node
  - name: w3
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "authority");
    expect(resolved.acceptsWorkFrom).toEqual(["w1", "w2", "w3"]);
  });

  it("expands mixed literal + @group refs", () => {
    const yaml = `
groups:
  workers: [w1, w2]
nodes:
  - name: authority
    recipe: mesh-authority
    messagesWith: [extra, "@workers"]
  - name: extra
    recipe: mesh-node
  - name: w1
    recipe: mesh-node
  - name: w2
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "authority");
    expect(resolved.messagesWith).toEqual(["extra", "w1", "w2"]);
  });

  it("applies group_bindings to members — escalatesTo field", () => {
    const yaml = `
groups:
  workers: [w1, w2]
group_bindings:
  workers:
    escalatesTo: authority
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
  - name: w2
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    expect(resolveNode(topo, "w1").escalatesTo).toBe("authority");
    expect(resolveNode(topo, "w2").escalatesTo).toBe("authority");
    expect(resolveNode(topo, "authority").escalatesTo).toBeUndefined();
  });

  it("applies group_bindings — submitsWorkTo and messagesWith fields", () => {
    const yaml = `
groups:
  workers: [w1, w2]
group_bindings:
  workers:
    submitsWorkTo: collector
    messagesWith: [authority]
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
    expect(w1.submitsWorkTo).toBe("collector");
    expect(w1.messagesWith).toEqual(["authority"]);
  });

  it("per-node overrides win over group_bindings", () => {
    const yaml = `
groups:
  workers: [w1]
group_bindings:
  workers:
    escalatesTo: default-authority
    messagesWith: [analyst]
nodes:
  - name: w1
    recipe: mesh-node
    escalatesTo: special-authority
    messagesWith: [writer]
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
    expect(resolved.escalatesTo).toBe("special-authority");
    expect(resolved.messagesWith).toEqual(["writer"]);
  });

  it("group_bindings can contain @group refs that get expanded", () => {
    const yaml = `
groups:
  workers: [w1, w2]
  reviewers: [r1, r2]
group_bindings:
  workers:
    messagesWith: ["@reviewers"]
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
    expect(resolveNode(topo, "w1").messagesWith).toEqual(["r1", "r2"]);
    expect(resolveNode(topo, "w2").messagesWith).toEqual(["r1", "r2"]);
  });

  it("node in multiple groups picks up all applicable bindings", () => {
    const yaml = `
groups:
  workers: [w1]
  submitters: [w1]
group_bindings:
  workers:
    escalatesTo: authority
  submitters:
    submitsWorkTo: collector
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
    expect(resolved.escalatesTo).toBe("authority");
    expect(resolved.submitsWorkTo).toBe("collector");
  });

  // ── Rejection cases ──────────────────────────────────────────────────────

  it("rejects @group ref to undefined group", () => {
    const yaml = `
nodes:
  - name: planner
    recipe: mesh-authority
    messagesWith: ["@nonexistent"]
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
    messagesWith: ["@missing"]
nodes:
  - name: w1
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "w1")).toThrow(/group.*missing/i);
  });

  it("rejects acceptsWorkFrom that references a non-existent node (after expansion)", () => {
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
    acceptsWorkFrom: [phantom]
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "authority")).toThrow(/node.*phantom/i);
  });

  it("rejects messagesWith that references a non-existent node (after expansion)", () => {
    const yaml = `
nodes:
  - name: planner
    recipe: mesh-authority
    messagesWith: [ghost]
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
    acceptsWorkFrom: ["@workers"]
  - name: w1
    recipe: mesh-node
    groups: [workers]
  - name: w2
    recipe: mesh-node
    groups: [workers]
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "authority");
    expect(resolved.acceptsWorkFrom).toEqual(["w1", "w2"]);
  });

  it("per-node groups can reference a group not declared at top level (implicit group)", () => {
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
    messagesWith: ["@implicit"]
  - name: anon-worker
    recipe: mesh-node
    groups: [implicit]
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "authority");
    expect(resolved.messagesWith).toEqual(["anon-worker"]);
  });

  it("mixes top-level and per-node groups for the same group name", () => {
    const yaml = `
groups:
  workers: [w1]
nodes:
  - name: authority
    recipe: mesh-authority
    acceptsWorkFrom: ["@workers"]
  - name: w1
    recipe: mesh-node
  - name: w2
    recipe: mesh-node
    groups: [workers]
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "authority");
    // top-level w1 first, then per-node w2
    expect(resolved.acceptsWorkFrom).toEqual(["w1", "w2"]);
  });

  it("per-node groups triggers group_binding for that node", () => {
    const yaml = `
group_bindings:
  workers:
    escalatesTo: authority
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    groups: [workers]
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "w1");
    expect(resolved.escalatesTo).toBe("authority");
  });

  it("anonymous node with groups field does not expand into @group refs (skipped)", () => {
    // After auto-naming the anonymous node gets a name; before that, it's skipped.
    // We test with the raw (pre-auto-naming) topology where the node has no name.
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
    acceptsWorkFrom: ["@workers"]
  - recipe: mesh-node
    escalatesTo: authority
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
    acceptsWorkFrom: ["@workers"]
  - recipe: mesh-node
    escalatesTo: authority
    groups: [workers]
`;
    const topo = parseTopology(yaml);
    // Simulate launcher auto-naming
    topo.nodes[1].name = "cottontail-worker";
    const resolved = resolveNode(topo, "authority");
    expect(resolved.acceptsWorkFrom).toEqual(["cottontail-worker"]);
  });
});

// ── resolveNode @group in scalar fields (round-robin) ────────────────────────

describe("resolveNode @group in scalar fields (round-robin)", () => {
  it("two workers sharing counterStates get different supervisors from a 2-member group", () => {
    const yaml = `
groups:
  reviewers: [r1, r2]
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    escalatesTo: "@reviewers"
  - name: w2
    recipe: mesh-node
    escalatesTo: "@reviewers"
  - name: r1
    recipe: mesh-node
  - name: r2
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const counterStates = new Map();
    const w1 = resolveNode(topo, "w1", counterStates);
    const w2 = resolveNode(topo, "w2", counterStates);
    expect(w1.escalatesTo).toBe("r1");
    expect(w2.escalatesTo).toBe("r2");
  });

  it("three workers and 2-member group → wrap-around: r1, r2, r1", () => {
    const yaml = `
groups:
  reviewers: [r1, r2]
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    escalatesTo: "@reviewers"
  - name: w2
    recipe: mesh-node
    escalatesTo: "@reviewers"
  - name: w3
    recipe: mesh-node
    escalatesTo: "@reviewers"
  - name: r1
    recipe: mesh-node
  - name: r2
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const counterStates = new Map();
    expect(resolveNode(topo, "w1", counterStates).escalatesTo).toBe("r1");
    expect(resolveNode(topo, "w2", counterStates).escalatesTo).toBe("r2");
    expect(resolveNode(topo, "w3", counterStates).escalatesTo).toBe("r1");
  });

  it("single-member group resolves to that member", () => {
    const yaml = `
groups:
  authority: [boss]
nodes:
  - name: boss
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    escalatesTo: "@authority"
`;
    const topo = parseTopology(yaml);
    const counterStates = new Map();
    expect(resolveNode(topo, "w1", counterStates).escalatesTo).toBe("boss");
  });

  it("submitsWorkTo resolves independently of supervisor counter (separate counter keys)", () => {
    const yaml = `
groups:
  collectors: [c1, c2]
  reviewers: [r1, r2]
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    escalatesTo: "@reviewers"
    submitsWorkTo: "@collectors"
  - name: w2
    recipe: mesh-node
    escalatesTo: "@reviewers"
    submitsWorkTo: "@collectors"
  - name: r1
    recipe: mesh-node
  - name: r2
    recipe: mesh-node
  - name: c1
    recipe: mesh-node
  - name: c2
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const counterStates = new Map();
    const w1 = resolveNode(topo, "w1", counterStates);
    const w2 = resolveNode(topo, "w2", counterStates);
    // supervisor counter: reviewers → r1, r2
    expect(w1.escalatesTo).toBe("r1");
    expect(w2.escalatesTo).toBe("r2");
    // submitsWorkTo counter: collectors → c1, c2 (independent)
    expect(w1.submitsWorkTo).toBe("c1");
    expect(w2.submitsWorkTo).toBe("c2");
  });

  it("two different fields targeting the same group share the counter — interleaved by node-declaration order", () => {
    // w1 uses @shared for escalatesTo and w2 uses @shared for submitsWorkTo.
    // Both share the same counter so interleaved calls advance it together.
    const yaml = `
groups:
  shared: [s1, s2, s3]
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    escalatesTo: "@shared"
  - name: w2
    recipe: mesh-node
    submitsWorkTo: "@shared"
  - name: s1
    recipe: mesh-node
  - name: s2
    recipe: mesh-node
  - name: s3
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const counterStates = new Map();
    // w1.escalatesTo → s1 (counter=0 → 1)
    const w1 = resolveNode(topo, "w1", counterStates);
    // w2.submitsWorkTo → s2 (counter=1 → 2, same group key)
    const w2 = resolveNode(topo, "w2", counterStates);
    expect(w1.escalatesTo).toBe("s1");
    expect(w2.submitsWorkTo).toBe("s2");
  });

  it("_resolutions payload contains expected entries for @group resolution", () => {
    const yaml = `
groups:
  reviewers: [r1, r2]
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    escalatesTo: "@reviewers"
  - name: r1
    recipe: mesh-node
  - name: r2
    recipe: mesh-node
`;
    const topo = parseTopology(yaml);
    const counterStates = new Map();
    const resolved = resolveNode(topo, "w1", counterStates);
    expect(resolved._resolutions).toHaveLength(1);
    expect(resolved._resolutions[0]).toEqual({
      field: "escalatesTo",
      group: "reviewers",
      member: "r1",
      policy: "round-robin",
    });
  });

  it("non-@group escalatesTo does NOT populate _resolutions", () => {
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    escalatesTo: authority
`;
    const topo = parseTopology(yaml);
    const resolved = resolveNode(topo, "w1");
    expect(resolved.escalatesTo).toBe("authority");
    expect(resolved._resolutions).toHaveLength(0);
  });

  it("empty group rejection: escalatesTo @empty with zero members throws with field name", () => {
    const yaml = `
groups:
  empty: []
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    escalatesTo: "@empty"
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "w1")).toThrow(/escalatesTo/i);
  });

  it("unknown group rejection: escalatesTo @no-such-group throws with group name in error", () => {
    const yaml = `
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    escalatesTo: "@no-such-group"
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "w1")).toThrow(/no-such-group/i);
  });

  it("resolved concrete name must exist: escalatesTo @grp with ghost member throws with ghost in error", () => {
    const yaml = `
groups:
  grp: [ghost]
nodes:
  - name: authority
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    escalatesTo: "@grp"
`;
    const topo = parseTopology(yaml);
    expect(() => resolveNode(topo, "w1")).toThrow(/ghost/i);
  });
});
