/**
 * entry-resolver.test.ts — engine-side tests for the canonical
 * entry-resolver.mjs copy. Near-copy of
 * pi-sandbox/.pi/extensions/_lib/entry-resolver.test.ts, repointed
 * at ../lib/entry-resolver.mjs.
 */
import { describe, it, expect } from "vitest";
import { resolveEntry, crashAutoShiftTarget } from "./entry-resolver.mjs";
import { parseTopology } from "./topology.mjs";

function parse(yaml: string) {
  return parseTopology(yaml);
}

// ── resolveEntry ──────────────────────────────────────────────────────────────

describe("resolveEntry", () => {
  it("synthesises entry from unique top supervisor when entry omitted", () => {
    const topo = parse(`
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker
    recipe: mesh-node
    escalatesTo: authority
`);
    const result = resolveEntry(topo);
    expect(result.entryPeer).toBe("authority");
    expect(result.topSupervisor).toBe("authority");
    expect(result.errors).toHaveLength(0);
  });

  it("returns null entryPeer when multiple top candidates (non-unique)", () => {
    const topo = parse(`
nodes:
  - name: a
    recipe: r
  - name: b
    recipe: r
`);
    const result = resolveEntry(topo);
    expect(result.entryPeer).toBeNull();
    expect(result.topSupervisor).toBeNull();
  });

  it("uses explicit entry field when provided and valid", () => {
    const topo = parse(`
entry: authority
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker
    recipe: mesh-node
    escalatesTo: authority
`);
    const result = resolveEntry(topo);
    expect(result.entryPeer).toBe("authority");
    expect(result.errors).toHaveLength(0);
  });

  it("emits an error when entry name is not in topology", () => {
    const topo = parse(`
entry: ghost
nodes:
  - name: authority
    recipe: mesh-authority
`);
    const result = resolveEntry(topo);
    expect(result.entryPeer).toBeNull();
    expect(result.errors.some((e) => /ghost/.test(e))).toBe(true);
  });

  it("resolves entry via @group ref to first-listed member", () => {
    const topo = parse(`
entry: "@authorities"
groups:
  authorities: [a1, a2]
nodes:
  - name: a1
    recipe: mesh-authority
  - name: a2
    recipe: mesh-authority
  - name: worker
    recipe: mesh-node
    escalatesTo: a1
`);
    const result = resolveEntry(topo);
    expect(result.entryPeer).toBe("a1");
    expect(result.errors).toHaveLength(0);
  });

  it("emits an error when @group ref resolves to zero members", () => {
    const topo = parse(`
entry: "@empty-group"
groups:
  empty-group: []
nodes:
  - name: authority
    recipe: r
`);
    const result = resolveEntry(topo);
    expect(result.errors.some((e) => /zero members/.test(e))).toBe(true);
  });

  it("emits an error when @group ref is undefined", () => {
    const topo = parse(`
entry: "@undefined"
nodes:
  - name: authority
    recipe: r
`);
    const result = resolveEntry(topo);
    expect(result.errors.some((e) => /undefined/.test(e))).toBe(true);
  });
});

// ── crashAutoShiftTarget ──────────────────────────────────────────────────────

describe("crashAutoShiftTarget", () => {
  it("returns the unique top supervisor", () => {
    const topo = parse(`
nodes:
  - name: authority
    recipe: mesh-authority
  - name: worker
    recipe: mesh-node
    escalatesTo: authority
`);
    expect(crashAutoShiftTarget(topo)).toBe("authority");
  });

  it("returns null when no unique top supervisor", () => {
    const topo = parse(`
nodes:
  - name: a
    recipe: r
  - name: b
    recipe: r
`);
    expect(crashAutoShiftTarget(topo)).toBeNull();
  });
});
