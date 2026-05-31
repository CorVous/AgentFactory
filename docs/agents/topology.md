# Topology YAML

Parent: [`docs/agents.md`](../agents.md). For the rails that read these
peer fields, see [`multi-agent.md`](./multi-agent.md); to launch and
observe a mesh, see [`testing.md`](./testing.md).

A topology YAML describes the full set of nodes in a mesh and their peer
relationships. `npm run mesh -- <file.yaml>` launches all nodes in parallel;
`scripts/launch-mesh.mjs` is the entry point.

## Schema

```yaml
bus_root: /tmp/my-mesh          # optional; auto-derived from filename if omitted

# Named groups for use in @ref expressions below.
groups:
  workers: [w1, w2, w3]
  reviewers: [r1, r2]

# Per-group Habitat-overlay defaults. Per-node fields override these.
# Resolution order: group_bindings (last group wins for scalar fields) → per-node.
group_bindings:
  workers:
    supervisor: authority       # all workers report to authority
    submitTo: collector         # all workers submit output to collector
    peers: ["@reviewers"]       # workers can message reviewers (expands to [r1, r2])
  reviewers:
    peers: ["@workers"]

nodes:
  - name: authority             # instance name on the bus (--peer-name)
    recipe: mesh-authority      # pi-sandbox/agents/<recipe>.yaml
    sandbox: /tmp/mesh/auth     # optional; auto-created under /tmp if omitted
    task: "..."                 # optional; appended to system prompt as per-instance role context

  # Habitat-overlay fields — override recipe + group_bindings values:
  - name: w1
    recipe: mesh-node
    supervisor: authority       # which peer to escalate approvals to
    submitTo: collector         # which peer receives submissions
    acceptedFrom: [authority]   # peers allowed to send approval-request / submission envelopes
    peers: [authority, r1]      # peers this node may address
```

All four peer fields (`supervisor`, `submitTo`, `acceptedFrom`, `peers`) are
optional. Nodes without them launch with only their recipe's own peer fields.

`name:` is also optional. When omitted, the launcher generates a
`<breed>-<shortName>` slug from the recipe (using the same breed-pool /
collision-detection machinery as `pi --recipe`). Auto-named nodes can't be
referenced by name elsewhere in the topology — `entry:`, `supervisor:`,
`submitTo:`, `acceptedFrom:`, `peers:`, and group memberships all need an
explicit name. Use it for "anonymous worker" nodes whose roles only flow
outward (e.g. several workers that all set `supervisor: authority` but are
never enumerated by the authority).

## Group references

`@<group>` references are supported in multiple topology fields, with different
resolution policies depending on the field type:

- **Array fields** (`acceptedFrom`, `peers`) — policy `expand-all`: the entire
  group member list is spliced in at the ref position. Every member of the
  referenced group is included.
- **Scalar fields** (`supervisor`, `submitTo`) — policy `round-robin`: each call
  to `resolveNode` for a node picks the next member of the group in a shared
  counter that advances in node-declaration order across the entire topology. This
  distributes workers evenly across a pool of supervisors without any per-node
  configuration.

All `@group` refs in binding arrays are expanded during resolution. The bus
always sees concrete peer names — groups are a topology-level authoring
convenience, not a bus-level concept.

```yaml
groups:
  workers: [w1, w2, w3]
  reviewers: [r1, r2]
nodes:
  - name: r1
    recipe: mesh-authority
  - name: r2
    recipe: mesh-authority
  - name: w1
    recipe: mesh-node
    supervisor: "@reviewers"   # round-robin → r1 (counter=0)
  - name: w2
    recipe: mesh-node
    supervisor: "@reviewers"   # round-robin → r2 (counter=1)
  - name: w3
    recipe: mesh-node
    supervisor: "@reviewers"   # round-robin → r1 (counter=2 % 2 = 0)
  - name: authority
    recipe: mesh-authority
    acceptedFrom: ["@workers"] # expand-all → [w1, w2, w3]
```

**Round-robin counter** is per-group and shared across all nodes in declaration
order. Two nodes referencing the same group always land on different members
(until the group wraps around). The counter is reset to zero at each launch —
the assignments are deterministic but not persisted across runs.

**Stderr logging.** For each `@group` scalar resolution, the launcher emits a
line to stderr:
```
launch-mesh: worker <node-name> → <field> <member> (round-robin)
```
Example: `launch-mesh: worker w1 → supervisor r1 (round-robin)`.

**Empty group is a hard error.** Referencing an `@group` that exists but has
zero members (`groups.reviewers: []`) blocks launch for both scalar and array
fields. `Habitat.supervisor` and `Habitat.submitTo` always carry concrete
scalar peer names — resolution happens entirely in the launcher before the
`--topology-overlay` JSON is built.

## Resolution order

For a given node, the effective Habitat overlay is computed as:

1. **Group bindings** — for each group the node belongs to (in declaration
   order), apply the binding's fields. Later groups overwrite earlier ones for
   scalar fields; array fields are also replaced.
2. **Per-node fields** — override everything from group bindings.
3. **Recipe fields** — used for any field not set by the topology at all.

## Validation

`scripts/launch-mesh.mjs` validates the full topology before spawning any node:

- Duplicate node names → error.
- `@group` references to undefined groups → error.
- `@group` references to empty groups → error (both array and scalar fields).
- `supervisor:` and `submitTo:` accept `@<group>` refs; the validator treats
  them as "set" when the group resolves to ≥1 member (they count as having an
  effective supervisor for the top-supervisor uniqueness check).
- `acceptedFrom` / `peers` referencing a name not in `nodes` → error.

## Launcher integration

For each pi-agent node the launcher builds the spawn argv via
`buildRecipeChildArgv` (from `packages/engine/agent/lib/child-spawn.mjs`)
and passes `--topology-overlay <json>` in the flags. The engine's
`recipe-loader` parses this flag at `session_start` and merges the
resolved peer fields into the Habitat; all rails read peer relationships
from `getHabitat()`.

## Example — grouped mesh

`pi-sandbox/meshes/grouped-mesh.yaml` shows a complete topology that exercises
groups, group bindings, and per-node overrides. `pi-sandbox/meshes/authority-mesh.yaml`
demonstrates `supervisor: "@authority"` round-robin resolution on its worker nodes.
