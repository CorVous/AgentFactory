/**
 * topology-validator.test.ts — hermetic unit tests for validateTopology().
 *
 * Rules exercised:
 *   - required `entry:` field
 *   - exactly one node with unset escalatesTo: (top supervisor)
 *   - unknown node type rejection (any type: other than undefined)
 *   - @group ref to undefined group
 *   - acceptsWorkFrom / messagesWith referencing undeclared node
 *   - top-supervisor TASK_RABBIT_MODEL warning (not error)
 *   - valid topologies pass cleanly
 */

import { describe, it, expect } from "vitest";
import { validateTopology } from "./topology-validator.mjs";

// Inline types for test readability — the authoritative typedefs live in topology-validator.mjs JSDoc.
type TopologyNode = {
  name: string;
  recipe?: string;
  type?: string;
  escalatesTo?: string;
  submitsWorkTo?: string;
  acceptsWorkFrom?: string[];
  messagesWith?: string[];
  groups?: string[];
};

type Topology = {
  entry?: string;
  bus_root?: string;
  groups?: Record<string, string[]>;
  group_bindings?: Record<string, { escalatesTo?: string; submitsWorkTo?: string; acceptsWorkFrom?: string[]; messagesWith?: string[] }>;
  nodes: TopologyNode[];
};

type RecipeModelLoader = (recipeName: string) => string | undefined;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid topology (one authority node, no entry yet). */
function minimalTopo(): Topology {
  return {
    entry: "authority",
    nodes: [{ name: "authority", recipe: "mesh-authority" }],
  };
}

/** Topology with two nodes — authority (no escalatesTo) + one worker. */
function twoNodeTopo(): Topology {
  return {
    entry: "authority",
    nodes: [
      { name: "authority", recipe: "mesh-authority" },
      { name: "worker", recipe: "mesh-node", escalatesTo: "authority" },
    ],
  };
}

// ── valid topologies ──────────────────────────────────────────────────────────

describe("valid topologies", () => {
  it("passes a minimal single-node topology with entry", () => {
    const result = validateTopology(minimalTopo());
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("passes a two-node topology", () => {
    const result = validateTopology(twoNodeTopo());
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("passes when entry differs from top supervisor", () => {
    const topo: Topology = {
      entry: "worker", // focused on worker, not authority
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "worker", recipe: "mesh-node", escalatesTo: "authority" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors).toHaveLength(0);
  });

  it("passes a topology with groups and group_bindings", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { workers: ["w1", "w2"] },
      group_bindings: { workers: { escalatesTo: "authority" } },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node" },
        { name: "w2", recipe: "mesh-node" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("passes with valid @group refs in per-node acceptsWorkFrom", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { workers: ["w1", "w2"] },
      nodes: [
        { name: "authority", recipe: "mesh-authority", acceptsWorkFrom: ["@workers"] },
        { name: "w1", recipe: "mesh-node", escalatesTo: "authority" },
        { name: "w2", recipe: "mesh-node", escalatesTo: "authority" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors).toHaveLength(0);
  });
});

// ── entry: field ──────────────────────────────────────────────────────────────

describe("entry: field", () => {
  it("passes a topology with no entry: when a unique top supervisor exists", () => {
    const topo: Topology = {
      // no entry: — synthesis from unique top supervisor covers it
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "worker", recipe: "mesh-node", escalatesTo: "authority" },
      ],
    };
    const result = validateTopology(topo);
    // No entry-related errors expected; the unique top supervisor is synthesised
    expect(result.errors.filter((e) => /entry/i.test(e))).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("fails validation when no entry: and zero top supervisors (all nodes have escalatesTo)", () => {
    const topo: Topology = {
      // no entry:
      nodes: [
        { name: "authority", recipe: "mesh-authority", escalatesTo: "external" },
        { name: "worker", recipe: "mesh-node", escalatesTo: "authority" },
      ],
    };
    const result = validateTopology(topo);
    // The top-supervisor uniqueness rule (Rule 3) fires — no separate entry error
    expect(result.errors.some((e) => /escalatesTo/i.test(e))).toBe(true);
    // No entry-specific error (entry is simply omitted)
    expect(result.errors.filter((e) => /entry/i.test(e))).toHaveLength(0);
  });

  it("fails validation when no entry: and multiple top supervisors", () => {
    const topo: Topology = {
      // no entry:
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "rogue", recipe: "mesh-authority" }, // also no escalatesTo
        { name: "worker", recipe: "mesh-node", escalatesTo: "authority" },
      ],
    };
    const result = validateTopology(topo);
    // The top-supervisor uniqueness rule fires — no separate entry error
    expect(result.errors.some((e) => /escalatesTo/i.test(e))).toBe(true);
    expect(result.errors.filter((e) => /entry/i.test(e))).toHaveLength(0);
  });

  it("rejects entry that names a non-existent peer", () => {
    const topo: Topology = {
      entry: "nobody",
      nodes: [{ name: "authority", recipe: "mesh-authority" }],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /nobody/i.test(e))).toBe(true);
  });

  it("does not add an entry-related error when entry is present and valid", () => {
    const result = validateTopology(minimalTopo());
    expect(result.errors.filter((e) => /entry/i.test(e))).toHaveLength(0);
  });

  it("rejects entry: @unknown-group with distinct error message", () => {
    const topo: Topology = {
      entry: "@no-such-group",
      nodes: [{ name: "authority", recipe: "mesh-authority" }],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /no-such-group/i.test(e) && /unknown/i.test(e))).toBe(true);
  });

  it("rejects entry: @empty (zero members) with distinct error message", () => {
    const topo: Topology = {
      entry: "@empty",
      groups: { empty: [] },
      nodes: [{ name: "authority", recipe: "mesh-authority" }],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /empty/i.test(e) && /zero members/i.test(e))).toBe(true);
  });

  it("passes entry: @group with non-empty members", () => {
    const topo: Topology = {
      entry: "@leaders",
      groups: { leaders: ["authority"] },
      nodes: [{ name: "authority", recipe: "mesh-authority" }],
    };
    const result = validateTopology(topo);
    expect(result.errors.filter((e) => /entry/i.test(e))).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ── unknown node type rejection ───────────────────────────────────────────────

describe("unknown node type rejection", () => {
  it("rejects a node with an unknown type (e.g. type: relay)", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "human", type: "relay" },
      ],
    };
    const result = validateTopology(topo);
    const typeErrors = result.errors.filter((e) => /unknown node type|human/i.test(e));
    expect(typeErrors).toHaveLength(1);
    expect(typeErrors[0]).toContain("human");
    // Must mention the unknown type value
    expect(typeErrors[0]).toMatch(/relay/i);
  });

  it("rejects multiple nodes with unknown types (one error per node)", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "human", type: "relay" },
        { name: "bot", type: "legacy-relay" },
      ],
    };
    const result = validateTopology(topo);
    const typeErrors = result.errors.filter((e) => /unknown node type/i.test(e));
    expect(typeErrors).toHaveLength(2);
  });

  it("does not reject a node with no type set", () => {
    const result = validateTopology(minimalTopo());
    expect(result.errors.filter((e) => /unknown node type/i.test(e))).toHaveLength(0);
  });
});

// ── top supervisor uniqueness ─────────────────────────────────────────────────

describe("top supervisor uniqueness", () => {
  it("rejects when multiple nodes have no escalatesTo: set", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "rogue", recipe: "mesh-authority" }, // also no escalatesTo
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /escalatesTo/i.test(e) && /multiple|rogue|authority/i.test(e))).toBe(true);
  });

  it("rejects when every node has escalatesTo set (no top)", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", escalatesTo: "external" },
        { name: "worker", recipe: "mesh-node", escalatesTo: "authority" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /escalatesTo/i.test(e))).toBe(true);
  });

  it("passes when exactly one node has no escalatesTo: set", () => {
    const result = validateTopology(twoNodeTopo());
    expect(result.errors.filter((e) => /escalatesTo.*multiple|multiple.*escalatesTo/i.test(e))).toHaveLength(0);
    expect(result.errors.filter((e) => /no.*escalatesTo|escalatesTo.*top/i.test(e))).toHaveLength(0);
  });

  it("counts group_binding escalatesTo as effectively set (not a top candidate)", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { workers: ["w1", "w2"] },
      group_bindings: { workers: { escalatesTo: "authority" } },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node" },
        { name: "w2", recipe: "mesh-node" },
      ],
    };
    const result = validateTopology(topo);
    // Only authority has no escalatesTo; w1 and w2 get it from group_binding
    expect(result.errors.filter((e) => /escalatesTo/i.test(e))).toHaveLength(0);
  });
});

// ── @group reference validation ───────────────────────────────────────────────

describe("@group reference validation", () => {
  it("rejects @group ref to undefined group in per-node messagesWith", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", messagesWith: ["@nonexistent"] },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /nonexistent/i.test(e))).toBe(true);
  });

  it("rejects @group ref to undefined group in per-node acceptsWorkFrom", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", acceptsWorkFrom: ["@missing-group"] },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /missing-group/i.test(e))).toBe(true);
  });

  it("rejects @group ref to undefined group in group_bindings.messagesWith", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { workers: ["w1"] },
      group_bindings: { workers: { messagesWith: ["@undefined-group"] } },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node", escalatesTo: "authority" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /undefined-group/i.test(e))).toBe(true);
  });
});

// ── undeclared peer references ────────────────────────────────────────────────

describe("undeclared peer references", () => {
  it("rejects acceptsWorkFrom referencing a name not in nodes", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", acceptsWorkFrom: ["phantom"] },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /phantom/i.test(e))).toBe(true);
  });

  it("rejects messagesWith referencing a name not in nodes", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", messagesWith: ["ghost"] },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /ghost/i.test(e))).toBe(true);
  });
});

// ── TASK_RABBIT_MODEL warning ─────────────────────────────────────────────────

describe("TASK_RABBIT_MODEL warning", () => {
  const taskRabbitLoader: RecipeModelLoader = (recipeName) => {
    if (recipeName === "mesh-node") return "TASK_RABBIT_MODEL";
    if (recipeName === "mesh-authority") return "LEAD_HARE_MODEL";
    return undefined;
  };

  it("emits a warning (not error) when top supervisor recipe uses TASK_RABBIT_MODEL", () => {
    const topo: Topology = {
      entry: "worker-boss",
      nodes: [
        { name: "worker-boss", recipe: "mesh-node" }, // TASK_RABBIT_MODEL, no escalatesTo
        { name: "worker", recipe: "mesh-node", escalatesTo: "worker-boss" },
      ],
    };
    const result = validateTopology(topo, taskRabbitLoader);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => /TASK_RABBIT_MODEL/i.test(w))).toBe(true);
    expect(result.warnings.some((w) => /worker-boss/i.test(w))).toBe(true);
  });

  it("does NOT emit a warning when top supervisor is LEAD_HARE_MODEL", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority" }, // LEAD_HARE_MODEL, no escalatesTo
        { name: "worker", recipe: "mesh-node", escalatesTo: "authority" },
      ],
    };
    const result = validateTopology(topo, taskRabbitLoader);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("does not emit a warning when no recipeModelLoader is provided", () => {
    const topo: Topology = {
      entry: "worker-boss",
      nodes: [
        { name: "worker-boss", recipe: "mesh-node" }, // recipe resolves to TASK_RABBIT_MODEL
        { name: "worker", recipe: "mesh-node", escalatesTo: "worker-boss" },
      ],
    };
    // No loader passed — can't inspect tier, so no warning
    const result = validateTopology(topo);
    expect(result.warnings).toHaveLength(0);
  });

  it("TASK_RABBIT_MODEL is a warning, not an error (launch is not blocked)", () => {
    const topo: Topology = {
      entry: "worker-boss",
      nodes: [
        { name: "worker-boss", recipe: "mesh-node" },
        { name: "worker", recipe: "mesh-node", escalatesTo: "worker-boss" },
      ],
    };
    const result = validateTopology(topo, taskRabbitLoader);
    // No errors — launch would proceed (just with a warning)
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("literal model ID (not a tier variable) does not trigger warning", () => {
    const literalModelLoader: RecipeModelLoader = () => "anthropic/claude-3-haiku";
    const topo: Topology = {
      entry: "authority",
      nodes: [{ name: "authority", recipe: "mesh-authority" }],
    };
    const result = validateTopology(topo, literalModelLoader);
    expect(result.warnings).toHaveLength(0);
  });
});

// ── per-node groups: field ────────────────────────────────────────────────────

describe("per-node groups field", () => {
  it("passes when a node uses per-node groups to declare membership in an implicit group, and another node @refs it", () => {
    // No top-level groups block — the group exists only because a node declares it.
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", acceptsWorkFrom: ["@workers"] },
        { name: "w1", recipe: "mesh-node", escalatesTo: "authority", groups: ["workers"] },
        { name: "w2", recipe: "mesh-node", escalatesTo: "authority", groups: ["workers"] },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects @group ref to a group name not declared by either top-level or per-node form", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", acceptsWorkFrom: ["@totally-unknown"] },
        { name: "w1", recipe: "mesh-node", escalatesTo: "authority" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /totally-unknown/i.test(e))).toBe(true);
  });

  it("counts per-node group_binding escalatesTo as effectively set (not a top candidate)", () => {
    // Node w1 declares groups: [workers] and group_bindings has workers.escalatesTo.
    // So w1 should NOT be a top candidate (it has an effective escalatesTo via binding).
    const topo: Topology = {
      entry: "authority",
      groups: undefined,
      group_bindings: { workers: { escalatesTo: "authority" } },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node", groups: ["workers"] },
      ],
    };
    const result = validateTopology(topo);
    // Only authority should be top candidate; no duplicate-escalatesTo error.
    expect(result.errors.filter((e) => /escalatesTo/i.test(e))).toHaveLength(0);
  });

  it("passes a mixed topology with both top-level groups and per-node groups for the same group", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { workers: ["w1"] },
      group_bindings: { workers: { escalatesTo: "authority" } },
      nodes: [
        { name: "authority", recipe: "mesh-authority", acceptsWorkFrom: ["@workers"] },
        { name: "w1", recipe: "mesh-node" },
        { name: "w2", recipe: "mesh-node", groups: ["workers"] },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors).toHaveLength(0);
  });
});

// ── @group in scalar fields ───────────────────────────────────────────────────

describe("@group in scalar fields", () => {
  it("escalatesTo: @reviewers with non-empty group passes", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { reviewers: ["authority"] },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node", escalatesTo: "@reviewers" },
      ],
    };
    const result = validateTopology(topo);
    // The @reviewers group has authority as the single member; no error expected.
    expect(result.errors.filter((e) => /escalatesTo|reviewers/i.test(e))).toHaveLength(0);
  });

  it("escalatesTo: @empty → error contains 'escalatesTo' and 'empty'", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { empty: [] },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node", escalatesTo: "@empty" },
      ],
    };
    const result = validateTopology(topo);
    const relevantErrors = result.errors.filter((e) => /empty/i.test(e));
    expect(relevantErrors.length).toBeGreaterThan(0);
    expect(relevantErrors.some((e) => /escalatesTo/i.test(e))).toBe(true);
  });

  it("submitsWorkTo: @empty → error contains 'submitsWorkTo' and 'empty'", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { empty: [] },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        // w1 needs a escalatesTo to not violate the top-supervisor rule
        { name: "w1", recipe: "mesh-node", escalatesTo: "authority", submitsWorkTo: "@empty" },
      ],
    };
    const result = validateTopology(topo);
    const relevantErrors = result.errors.filter((e) => /empty/i.test(e));
    expect(relevantErrors.length).toBeGreaterThan(0);
    expect(relevantErrors.some((e) => /submitsWorkTo/i.test(e))).toBe(true);
  });

  it("escalatesTo: @unknown → existing unknown-group error format", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node", escalatesTo: "@unknown-grp" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /unknown-grp/i.test(e))).toBe(true);
  });

  it("top-supervisor uniqueness: node with escalatesTo: @reviewers (non-empty) is NOT a top candidate", () => {
    // authority has no escalatesTo (top candidate); workers all have escalatesTo: @reviewers
    // reviewers group → [authority] (a concrete non-empty group)
    // So w1, w2 each have an effective escalatesTo (authority via @reviewers)
    // Only authority should be the top candidate.
    const topo: Topology = {
      entry: "authority",
      groups: { reviewers: ["authority"] },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node", escalatesTo: "@reviewers" },
        { name: "w2", recipe: "mesh-node", escalatesTo: "@reviewers" },
      ],
    };
    const result = validateTopology(topo);
    // Should have exactly one top candidate (authority) → no escalatesTo error
    expect(result.errors.filter((e) => /escalatesTo/i.test(e))).toHaveLength(0);
  });

  it("group_bindings.workers.escalatesTo: @reviewers (non-empty) → no top-candidate added for workers; passes", () => {
    const topo: Topology = {
      entry: "authority",
      groups: {
        workers: ["w1", "w2"],
        reviewers: ["authority"],
      },
      group_bindings: {
        workers: { escalatesTo: "@reviewers" },
      },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node" },
        { name: "w2", recipe: "mesh-node" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors).toHaveLength(0);
  });

  it("group_bindings.workers.escalatesTo: @empty → empty-group error referencing group_bindings.workers.escalatesTo", () => {
    const topo: Topology = {
      entry: "authority",
      groups: {
        workers: ["w1"],
        empty: [],
      },
      group_bindings: {
        workers: { escalatesTo: "@empty" },
      },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node" },
      ],
    };
    const result = validateTopology(topo);
    const relevantErrors = result.errors.filter((e) => /empty/i.test(e));
    expect(relevantErrors.length).toBeGreaterThan(0);
    // Error should mention the binding context
    expect(relevantErrors.some((e) => /group_bindings.*workers.*escalatesTo|escalatesTo.*group_bindings.*workers/i.test(e))).toBe(true);
  });
});
