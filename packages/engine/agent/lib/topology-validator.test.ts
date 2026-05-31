/**
 * topology-validator.test.ts — engine-side tests for the canonical
 * topology-validator.mjs copy. Near-copy of
 * pi-sandbox/.pi/extensions/_lib/topology-validator.test.ts, repointed
 * at ../lib/topology-validator.mjs.
 */
import { describe, it, expect } from "vitest";
import { validateTopology } from "./topology-validator.mjs";
import { parseTopology } from "./topology.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

function parse(yaml: string) {
  return parseTopology(yaml);
}

function validate(yaml: string, loader?: (r: string) => string | undefined) {
  return validateTopology(parse(yaml), loader);
}

// ── Valid topologies (no errors) ─────────────────────────────────────────────

describe("validateTopology — valid topologies", () => {
  it("passes a minimal two-node topology", () => {
    const { errors } = validate(`
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker
    recipe: mesh-node
    escalatesTo: authority
`);
    expect(errors).toHaveLength(0);
  });

  it("passes when entry field matches a node name", () => {
    const { errors } = validate(`
entry: authority
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker
    recipe: mesh-node
    escalatesTo: authority
`);
    expect(errors).toHaveLength(0);
  });

  it("passes when entry resolves via @group", () => {
    const { errors } = validate(`
groups:
  authorities: [authority]
entry: "@authorities"
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker
    recipe: mesh-node
    escalatesTo: authority
`);
    expect(errors).toHaveLength(0);
  });

  it("passes a topology with group_bindings providing escalatesTo", () => {
    const { errors } = validate(`
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
`);
    expect(errors).toHaveLength(0);
  });
});

// ── Error cases ───────────────────────────────────────────────────────────────

describe("validateTopology — error cases", () => {
  it("emits an error when entry references an unknown node", () => {
    const { errors } = validate(`
entry: nonexistent
nodes:
  - name: authority
    recipe: mesh-authority
`);
    expect(errors.some((e: string) => /nonexistent/.test(e))).toBe(true);
  });

  it("emits an error when all nodes have escalatesTo (no top supervisor)", () => {
    const { errors } = validate(`
nodes:
  - name: a
    recipe: r
    escalatesTo: b
  - name: b
    recipe: r
    escalatesTo: a
`);
    expect(errors.some((e: string) => /every node has/.test(e) || /at least one/.test(e))).toBe(true);
  });

  it("emits an error when multiple nodes have no escalatesTo", () => {
    const { errors } = validate(`
nodes:
  - name: a
    recipe: r
  - name: b
    recipe: r
`);
    expect(errors.some((e: string) => /multiple nodes/.test(e))).toBe(true);
  });

  it("emits an error for unknown node type", () => {
    const { errors } = validate(`
nodes:
  - name: relay
    recipe: r
    type: relay
`);
    expect(errors.some((e: string) => /unknown node type/.test(e))).toBe(true);
  });

  it("emits an error for @group ref to undefined group in escalatesTo", () => {
    const { errors } = validate(`
nodes:
  - name: worker
    recipe: r
    escalatesTo: "@undefined-group"
`);
    expect(errors.some((e: string) => /undefined-group/.test(e))).toBe(true);
  });

  it("emits an error for acceptsWorkFrom referencing an undeclared peer", () => {
    const { errors } = validate(`
nodes:
  - name: authority
    recipe: r
  - name: worker
    recipe: r
    escalatesTo: authority
    acceptsWorkFrom: [nonexistent]
`);
    expect(errors.some((e: string) => /nonexistent/.test(e))).toBe(true);
  });

  it("emits an error for messagesWith referencing an undeclared peer", () => {
    const { errors } = validate(`
nodes:
  - name: authority
    recipe: r
  - name: worker
    recipe: r
    escalatesTo: authority
    messagesWith: [ghost]
`);
    expect(errors.some((e: string) => /ghost/.test(e))).toBe(true);
  });

  it("emits an error for @group ref to empty group in group_bindings.escalatesTo", () => {
    const { errors } = validate(`
groups:
  empty: []
group_bindings:
  workers:
    escalatesTo: "@empty"
nodes:
  - name: authority
    recipe: r
  - name: worker
    recipe: r
    groups: [workers]
`);
    expect(errors.some((e: string) => /empty/.test(e))).toBe(true);
  });
});

// ── Warnings ─────────────────────────────────────────────────────────────────

describe("validateTopology — warnings", () => {
  it("emits a warning when top supervisor uses TASK_RABBIT_MODEL", () => {
    const loader = (_: string) => "TASK_RABBIT_MODEL";
    const { warnings } = validate(`
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker
    recipe: mesh-node
    escalatesTo: authority
`, loader);
    expect(warnings.some((w) => /TASK_RABBIT_MODEL/.test(w))).toBe(true);
  });

  it("does not warn when no recipeModelLoader is provided", () => {
    const { warnings } = validate(`
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker
    recipe: mesh-node
    escalatesTo: authority
`);
    expect(warnings).toHaveLength(0);
  });
});
