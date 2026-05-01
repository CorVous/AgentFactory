/**
 * topology-validator.test.ts — hermetic unit tests for validateTopology().
 *
 * Rules exercised:
 *   - required `entry:` field
 *   - exactly one node with unset supervisor: (top supervisor)
 *   - type: relay node rejection with deprecation pointer
 *   - @group ref to undefined group
 *   - acceptedFrom / peers referencing undeclared node
 *   - top-supervisor TASK_RABBIT_MODEL warning (not error)
 *   - valid topologies pass cleanly
 */

import { describe, it, expect } from "vitest";
import { validateTopology } from "./topology-validator.mjs";

// Inline types for test readability — the authoritative typedefs live in topology-validator.mjs JSDoc.
type TopologyNode = {
  name: string;
  recipe?: string;
  type?: "relay";
  supervisor?: string;
  acceptedFrom?: string[];
  peers?: string[];
};

type Topology = {
  entry?: string;
  bus_root?: string;
  groups?: Record<string, string[]>;
  group_bindings?: Record<string, { supervisor?: string; submitTo?: string; acceptedFrom?: string[]; peers?: string[] }>;
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

/** Topology with two nodes — authority (no supervisor) + one worker. */
function twoNodeTopo(): Topology {
  return {
    entry: "authority",
    nodes: [
      { name: "authority", recipe: "mesh-authority" },
      { name: "worker", recipe: "mesh-node", supervisor: "authority" },
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
        { name: "worker", recipe: "mesh-node", supervisor: "authority" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors).toHaveLength(0);
  });

  it("passes a topology with groups and group_bindings", () => {
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
    const result = validateTopology(topo);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("passes with valid @group refs in per-node acceptedFrom", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { workers: ["w1", "w2"] },
      nodes: [
        { name: "authority", recipe: "mesh-authority", acceptedFrom: ["@workers"] },
        { name: "w1", recipe: "mesh-node", supervisor: "authority" },
        { name: "w2", recipe: "mesh-node", supervisor: "authority" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors).toHaveLength(0);
  });
});

// ── entry: field ──────────────────────────────────────────────────────────────

describe("entry: field", () => {
  it("rejects a topology missing entry:", () => {
    const topo: Topology = {
      nodes: [{ name: "authority", recipe: "mesh-authority" }],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /entry/i.test(e))).toBe(true);
  });

  it("rejects entry that names a non-existent peer", () => {
    const topo: Topology = {
      entry: "nobody",
      nodes: [{ name: "authority", recipe: "mesh-authority" }],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /nobody/i.test(e))).toBe(true);
  });

  it("does not add an entry-missing error when entry is present and valid", () => {
    const result = validateTopology(minimalTopo());
    expect(result.errors.filter((e) => /entry/i.test(e))).toHaveLength(0);
  });
});

// ── type: relay rejection ─────────────────────────────────────────────────────

describe("type: relay rejection", () => {
  it("rejects a node with type: relay", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "human", type: "relay" },
      ],
    };
    const result = validateTopology(topo);
    const relayErrors = result.errors.filter((e) => /relay/i.test(e));
    expect(relayErrors).toHaveLength(1);
    expect(relayErrors[0]).toContain("human");
    // Deprecation pointer must reference ADR-0004
    expect(relayErrors[0]).toMatch(/ADR-0004|deprecated|launcher/i);
  });

  it("rejects multiple relay nodes (one error per relay node)", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "human", type: "relay" },
        { name: "human2", type: "relay" },
      ],
    };
    const result = validateTopology(topo);
    const relayErrors = result.errors.filter((e) => /relay/i.test(e));
    expect(relayErrors).toHaveLength(2);
  });
});

// ── top supervisor uniqueness ─────────────────────────────────────────────────

describe("top supervisor uniqueness", () => {
  it("rejects when multiple nodes have no supervisor: set", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "rogue", recipe: "mesh-authority" }, // also no supervisor
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /supervisor/i.test(e) && /multiple|rogue|authority/i.test(e))).toBe(true);
  });

  it("rejects when every node has a supervisor set (no top)", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", supervisor: "external" },
        { name: "worker", recipe: "mesh-node", supervisor: "authority" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /supervisor/i.test(e))).toBe(true);
  });

  it("passes when exactly one node has no supervisor: set", () => {
    const result = validateTopology(twoNodeTopo());
    expect(result.errors.filter((e) => /supervisor.*multiple|multiple.*supervisor/i.test(e))).toHaveLength(0);
    expect(result.errors.filter((e) => /no.*supervisor|supervisor.*top/i.test(e))).toHaveLength(0);
  });

  it("counts group_binding supervisor as effectively set (not a top candidate)", () => {
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
    const result = validateTopology(topo);
    // Only authority has no supervisor; w1 and w2 get it from group_binding
    expect(result.errors.filter((e) => /supervisor/i.test(e))).toHaveLength(0);
  });
});

// ── @group reference validation ───────────────────────────────────────────────

describe("@group reference validation", () => {
  it("rejects @group ref to undefined group in per-node peers", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", peers: ["@nonexistent"] },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /nonexistent/i.test(e))).toBe(true);
  });

  it("rejects @group ref to undefined group in per-node acceptedFrom", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", acceptedFrom: ["@missing-group"] },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /missing-group/i.test(e))).toBe(true);
  });

  it("rejects @group ref to undefined group in group_bindings.peers", () => {
    const topo: Topology = {
      entry: "authority",
      groups: { workers: ["w1"] },
      group_bindings: { workers: { peers: ["@undefined-group"] } },
      nodes: [
        { name: "authority", recipe: "mesh-authority" },
        { name: "w1", recipe: "mesh-node", supervisor: "authority" },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /undefined-group/i.test(e))).toBe(true);
  });
});

// ── undeclared peer references ────────────────────────────────────────────────

describe("undeclared peer references", () => {
  it("rejects acceptedFrom referencing a name not in nodes", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", acceptedFrom: ["phantom"] },
      ],
    };
    const result = validateTopology(topo);
    expect(result.errors.some((e) => /phantom/i.test(e))).toBe(true);
  });

  it("rejects peers referencing a name not in nodes", () => {
    const topo: Topology = {
      entry: "authority",
      nodes: [
        { name: "authority", recipe: "mesh-authority", peers: ["ghost"] },
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
        { name: "worker-boss", recipe: "mesh-node" }, // TASK_RABBIT_MODEL, no supervisor
        { name: "worker", recipe: "mesh-node", supervisor: "worker-boss" },
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
        { name: "authority", recipe: "mesh-authority" }, // LEAD_HARE_MODEL, no supervisor
        { name: "worker", recipe: "mesh-node", supervisor: "authority" },
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
        { name: "worker", recipe: "mesh-node", supervisor: "worker-boss" },
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
        { name: "worker", recipe: "mesh-node", supervisor: "worker-boss" },
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
