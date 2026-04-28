# Phase 6a — topology YAML schema + launcher integration

**Goal.** The existing `scripts/launch-mesh.mjs` (carried over from the original mesh deployment branch before the deepening began) needs to know about the post-Phase-3b Habitat fields. Topology YAMLs gain `supervisor`, `submitTo`, `acceptedFrom`, `peers` per node + a `groups` section for named groups + per-group bindings. Launcher resolves these, expands group references, and passes the resulting fields to each peer's `run-agent.mjs` invocation (which writes them into the Habitat spec).

**Behaviour after this phase:**
- A topology YAML can declare per-node peer relationships and named groups.
- `peers: ["@workers"]` in a node's entry resolves to the concrete peer list at launch time (sender-side expansion; the bus sees only concrete names).
- Group bindings (`group_bindings.workers.supervisor: authority`) flow into each member's effective fields, with per-node overrides winning.
- Existing topology YAMLs (no peer fields) continue to launch unchanged.

This file is deleted in the PR that ships Phase 6a.

---

## Prerequisite

Phase 3b on main (Habitat carries the four peer fields and the runner serialises them). 3c not strictly needed — but if 3c is merged (it is), supervisors launched via topology will actually have a working inbound rail.

**Parallelisable with Phase 4a and 4b.** Touches the launcher and topology parsing, not the rails or workers. Zero file overlap with 4a/4b.

## Required reading

- `scripts/launch-mesh.mjs` — current state (read end-to-end).
- `pi-sandbox/meshes/authority-mesh.yaml` — example topology that exists today (no peer fields yet).
- `scripts/run-agent.mjs` — how a single peer's Habitat spec is constructed from a recipe + flags. Topology fields need to flow through to here.
- `docs/adr/0001-mesh-subsumes-delegation.md` and `0002-habitat-materialises-once.md` — the topology and habitat concepts.
- `docs/phases/_notes-for-phase-3.md` and `_notes-for-phase-4.md` (if present) for context.

## Skill to invoke

`/tdd`. Topology parsing + group expansion is pure data transformation; perfect for unit tests.

## Branch strategy

Off latest `main`. Suggested: **`claude/phase-6a-topology-yaml`**.

```sh
git fetch origin main
git checkout -b claude/phase-6a-topology-yaml origin/main
npm test   # confirm baseline
```

## Scope — what's in (TDD order)

### Step 1 — `_lib/topology.ts` (testable parser)

Note: `_lib/topology.ts` is a **node-side** library (used by `launch-mesh.mjs`, which runs in Node, not inside pi). The existing `_lib/` directory under `pi-sandbox/.pi/extensions/_lib/` is for pi-extension code. **Place this new file** at `pi-sandbox/.pi/extensions/_lib/topology.ts` for consistency with the other libs (it can still be imported from a `.mjs` script — vitest handles the TS), or at `scripts/_lib/topology.ts` if you'd rather keep node-side and pi-side libs separate. **Recommend: `pi-sandbox/.pi/extensions/_lib/topology.ts`** — single library tree, reuses existing test infrastructure.

**Tests first** in `_lib/topology.test.ts`:

- Parse a minimal topology with one node — produces correct per-node Habitat overlay.
- Parse with `groups` defined — expand `@<group>` references in `peers`/`acceptedFrom` to concrete peer names.
- Parse with `group_bindings` — apply the binding to each member node, but per-node overrides win.
- Reject `@<group>` references to undefined groups.
- Reject duplicate node names.
- Reject `acceptedFrom`/`peers` that reference non-existent nodes (after group expansion).

**Then implementation:**

```ts
export interface TopologyNode {
  name: string;
  recipe?: string;        // omitted for type: relay
  type?: "relay";
  sandbox?: string;
  task?: string;
  // Habitat-overlay fields (post-3b):
  supervisor?: string;
  submitTo?: string;
  acceptedFrom?: string[];  // may contain @group refs
  peers?: string[];         // may contain @group refs
}

export interface GroupBinding {
  supervisor?: string;
  submitTo?: string;
  acceptedFrom?: string[];
  peers?: string[];
}

export interface Topology {
  bus_root?: string;
  groups?: Record<string, string[]>;
  group_bindings?: Record<string, GroupBinding>;
  nodes: TopologyNode[];
}

export interface ResolvedNode {
  supervisor?: string;
  submitTo?: string;
  acceptedFrom: string[];   // concrete peer names; groups expanded
  peers: string[];           // concrete peer names; groups expanded
}

export function parseTopology(yamlText: string): Topology;

// Returns the effective Habitat-overlay fields for one node.
// Resolution order: recipe defaults → group_bindings (per group) → per-node overrides.
// (Recipe defaults aren't visible from topology alone; the runner merges them.)
// Group expansion happens here and resolves @<group> refs to concrete names.
export function resolveNode(topo: Topology, nodeName: string): ResolvedNode;
```

### Step 2 — `launch-mesh.mjs` integration

Use `parseTopology` to validate the YAML at launch start. For each node, compute `resolveNode` and pass the resulting overlay to that node's `run-agent.mjs` invocation.

**Recommend: a single `--topology-overlay <json>` flag** added to passthrough, mirroring how `--habitat-spec` already works at the runner level. The launcher serializes the overlay JSON; the runner unpacks and merges it into `habitatSpec`.

### Step 3 — runner consumes the overlay

In `scripts/run-agent.mjs`, after constructing `habitatSpec` from the recipe, parse `--topology-overlay` (if present) and overlay fields onto `habitatSpec`. Per-overlay-field overrides recipe values.

Specifically:
- If overlay has `supervisor`, replace `habitatSpec.supervisor` (recipe value lost).
- If overlay has `submitTo`, replace.
- If overlay has `acceptedFrom`, **replace** (not merge) — the topology's view of allowlists is authoritative for that deployment.
- If overlay has `peers`, replace.

### Step 4 — docs

Update `docs/agents.md` with a new section "Topology YAML" documenting the schema, group syntax, and binding rules. Reference `pi-sandbox/meshes/authority-mesh.yaml` as the existing example (which doesn't yet use the new fields).

If you want, write a new example topology that exercises the new fields — but **don't break the existing one**. Add a new file (e.g. `pi-sandbox/meshes/grouped-mesh.yaml`) or add the fields to `authority-mesh.yaml` in a way that's still launchable (the new fields are all optional).

## Scope — what's NOT in

- **No worker-side submission emit** (Phase 4a).
- **No supervisor-side apply** (Phase 4b).
- **No bus-level group fanout.** Group expansion is sender-side at topology resolve time. The bus continues to see only concrete peer names.
- **No new envelope kinds** or **status reporting**. Status reporting (the `status` envelope kind for `delegation-boxes` to consume) is Phase 6c.
- **No deletion of `agent-spawn.ts` or `agent-status-reporter.ts`.** Phase 5.
- **No changes to `mesh-authority.ts`** beyond what `run-agent.mjs` brings indirectly.
- **No CLI ergonomics changes** to `launch-mesh.mjs` (e.g. dry-run mode, validation-only mode, etc.). Out of scope; can land later.

## Step-by-step checklist

```
[ ]  1. Read prereqs.
[ ]  2. /tdd.
[ ]  3. Branch claude/phase-6a-topology-yaml from main.

  RED:
[ ]  4. _lib/topology.test.ts — parse + group expansion + bindings +
        rejection cases.

  GREEN:
[ ]  5. _lib/topology.ts — parser + resolveNode.

  INTEGRATION:
[ ]  6. scripts/launch-mesh.mjs — use parseTopology; pass per-node
        overlay via --topology-overlay flag in passthrough.
[ ]  7. scripts/run-agent.mjs — consume --topology-overlay; merge into
        habitatSpec.

[ ]  8. docs/agents.md — Topology YAML section.
[ ]  9. Optional: extend pi-sandbox/meshes/authority-mesh.yaml or add
        a new pi-sandbox/meshes/grouped-mesh.yaml exercising the new
        fields. Ensure the existing authority-mesh launches unchanged.

[ ] 10. npm test — green.
[ ] 11. Smoke test: launch authority-mesh; confirm each node's
        [AGENT_DEBUG] habitat: dump shows correctly resolved fields.
[ ] 12. Smoke test: a topology with @groups; confirm expansion.
[ ] 13. Commit per logical step; push; delete this plan file.
```

## Acceptance criteria

- `_lib/topology.ts` exists; parses, expands groups, applies bindings.
- `launch-mesh.mjs` uses `parseTopology` and passes resolved overlays.
- `run-agent.mjs` consumes `--topology-overlay` and merges into `habitatSpec`.
- A topology with `@groups` launches; resolved fields appear in each peer's `[AGENT_DEBUG] habitat:` dump.
- Existing topology files (without new fields) launch unchanged.
- `docs/agents.md` documents the schema.
- This plan file deleted.

## Hand-back

Push to `origin/claude/phase-6a-topology-yaml`. Report SHAs, npm test output, smoke test outputs (one with groups, one without), any conflicts you found with `mesh-authority.ts`'s existing behavior.

Don't open a PR.
