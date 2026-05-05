# Recipes own the graph; launches are eliminated; meshes are host-grown

A **Mesh** is a single host **Peer** plus its transitive **Spawn Tree**. **Recipes** declare both the **Role** they instantiate *and* the wiring of any peers they spawn (`spawns:` block, with optional symbolic peer references like `$spawner` and `$siblings`). The launch artifact (today's `pi-sandbox/meshes/<name>.yaml`) is removed; what used to be a topology becomes a host **Recipe** with an optional `initial_mesh:` block listing peers to pre-spawn at session_start. `npm run mesh` collapses to a thin entry-point that delegates to the same `npm run agent -- <host>` path. One artifact type, one launch command, one place where graph shape lives.

## Why

- **The recipe/topology split was along the wrong seam.** Today's topology YAML mixes two concerns: *graph shape* (writer's supervisor is foreman; reviewer accepts submissions from writer — role-level knowledge) and *launch declaration* (these named instances at these sandboxes with this bus root, all alive at startup — launch-level knowledge). Graph shape leaks across both, so the same fact ("writer reports to foreman") gets expressed in topology rather than where it belongs. Pushing graph shape into recipes — where role knowledge already lives — leaves launches with nothing recipes don't already cover.
- **One artifact, one mental model.** A reader who wants to understand what a mesh does opens the host **Recipe** and follows the `spawns:` and `initial_mesh:` blocks. The transitive expansion *is* the graph; rendering it (e.g. as a `/tree` slash command) is a runtime concern, not an authoring one.
- **Symbolic peer references replace topology-time graph wiring.** A recipe spawning workers writes `submitsWorkTo: $spawner` once; instances of that recipe under different parents resolve `$spawner` to their respective parents. Today's per-topology repetition (writer-1 reports to foreman; writer-2 reports to foreman; reviewer reports to foreman) collapses into one symbolic line.
- **The `agents:` rename to `spawns:` removes the agent-vs-peer overload.** CONTEXT.md already retired "agent" as ambiguous between **Role** and **Peer**. The recipe field that today reads `agents: [writer]` is structurally a list of *spawn declarations*, not a list of agents. Renaming aligns the YAML with the conceptual model and lets each entry carry per-spawn wiring (object form) when overrides are needed.
- **The `delegate` tool collapses into `mesh_spawn`.** ADR-0001 framed the mesh as the substrate that subsumes delegation, but kept `delegate` as an atomic-and-collect specialisation. Once recipes own the graph and any peer can spawn long-lived workers, the atomic shape ("spawn → ship submission → die") becomes one usage pattern of the same primitive ("`mesh_spawn` → drive via `peer_send` → `mesh_kill`"), and the lifecycle distinction stops earning its place at the tool surface. End-of-turn batched approval — atomic-delegate's killer property — moves up to the supervisor inbound rail and benefits every supervisor, not just delegating ones.

## Considered alternatives

- **Keep launches as a separate artifact type with `host:` selecting a recipe and `initial_spawn:` driving boot.** Rejected per user: nothing is left in the launch that recipes cannot already express; a separate file type pays a discoverability tax (two directories, two schemas, two validators) for no information that recipes don't already carry. Per-launch overrides (different boot configurations of the same role) survive cleanly via recipe `extends:` chaining (per ADR-0006), so the only structural counter-argument falls away.
- **Hybrid: launches stay but become thin wrappers.** Considered as a transitional shape. Rejected: the long-term cost of two artifact types — readers wondering "is this a recipe or a mesh?" — outweighs the short-term migration ease. Cutting once is cleaner.
- **Topology graph stays in launches; only `delegate` collapses into `mesh_spawn`.** Rejected: leaves the recipe/topology split intact and forces every multi-peer mesh to author both files. The original prompt was a re-conception of the mesh system; this alternative is a partial fix that defers the harder cut.
- **Recipes opt into being a "host" via an explicit `host: true` field.** Rejected: the host is determined by *how* a recipe is launched, not by its content. A recipe boots as host iff `--is-host` was set by the runner on root invocation; the same recipe spawned as a worker via `mesh_spawn` runs without `--is-host`. Adding a content-level marker either duplicates the runtime distinction or constrains where a recipe can be used.
- **Single tool `mesh_spawn(recipe, lifetime: "atomic" | "long-lived")`** with the lifecycle as a parameter. Rejected: parameterising lifecycle at tool-pick-time trains the LLM to treat it as a knob on the same operation; getting it wrong silently changes the worker's death semantics. Two verbs (`mesh_spawn`, `mesh_kill`) with explicit teardown make the lifecycle visible at the call site.
- **Recipes-extend-recipes for boot variants** with a `host: true` flag rather than `initial_mesh:`. Rejected per the same logic as the explicit-host marker: hosting is a runtime property determined by `--is-host`, not a recipe-author decision.
- **Group-level `agents:` block** declaring spawn capability per-recipe-group rather than per-recipe. Rejected: groups are an addressing-scope construct (per ADR-0008), not a capability one. Spawn capability is naturally per-recipe (some roles spawn, others don't); flattening it onto groups conflates two axes.

## Consequences

### Schema

- **`pi-sandbox/meshes/` is removed.** All three example topologies (`anon-grouped-mesh.yaml`, `authority-mesh.yaml`, `grouped-mesh.yaml`) are migrated to host recipes in `pi-sandbox/agents/` with the same shape.
- **Recipe gains `spawns:` block.** Each entry is either a bare recipe name (default tree wiring: `escalatesTo: $spawner`, `submitsWorkTo: $spawner`, `messagesWith: [$spawner]`, `acceptsWorkFrom: [$spawner]`) or an object form with explicit overrides:

  ```yaml
  spawns:
    - writer                                 # bare-string: default tree wiring
    - recipe: critic                         # object form: overrides
      messagesWith: ["@$myGroups"]
      acceptsWorkFrom: ["@$myGroups"]
  ```

- **Recipe gains `initial_mesh:` block.** Optional list of peers spawned at session_start by the host's `mesh-mux` extension *before* the LLM's first turn. Entries carry `recipe:`, optional `name:` (for cross-references), and optional `groups:` (per ADR-0008). Runner-executed: requires neither `mesh_spawn` in `tools:` nor the recipe in `spawns:`. The "fixed cohort, no spawn capability" pattern (e.g., a moderator with three critics that cannot spawn more) works because `initial_mesh:` and `spawns:` are independent gates.
- **Recipe field `agents:` is renamed `spawns:`.** Existing recipes with `agents: [writer]` continue to mean the same thing under the new name; the schema migration is mechanical.
- **Symbolic peer references** `$spawner`, `$siblings`, `@$myGroups`, `@<group>:<recipe>`, `@<recipe>` — all defined and resolved by the host's `mesh-mux` (per ADR-0008 for groups, this ADR for `$spawner`/`$siblings`).
- **`mesh_spawn` and `mesh_kill` are implicit-wired** when `spawns:` is non-empty: the runner adds them to the recipe's `tools:` allowlist and loads the `mesh-spawn` extension. Inverse rejection: declaring `tools: [mesh_spawn]` without `spawns:` is a recipe-parse error, mirroring the existing `delegate`/`agents:` rule.
- **Field `acceptedFrom:` is renamed `acceptsWorkFrom:`** (with semantics unchanged: list of peers from whom this peer accepts typed control envelopes — submissions, approval-requests). The rename and the supervisor/escalatesTo/submitTo/peers renames are described in CONTEXT.md.

### Runner (`scripts/run-agent.mjs`)

- **`--is-host` flag added.** Set by the runner only on root invocation (i.e. when not invoked recursively from another `run-agent.mjs` via `mesh_spawn`). Cleared in spawned children. The `mesh-mux` extension self-gates on this flag.
- **`applyAgentsField` renames to `applySpawnsField`.** Same logic, new field name. Implicit-wires `mesh-spawn` extension and the `mesh_spawn` / `mesh_kill` tools when `spawns:` is non-empty.
- **`--topology-path` and `--topology-overlay` flags are removed** in favour of the host's `mesh-mux` extension reading the recipe's `spawns:` and `initial_mesh:` directly. Workers receive their resolved Habitat overlay via `--habitat-spec` (existing) carried through the spawn protocol (per ADR-0009).

### Launcher (`scripts/launch-mesh.mjs`)

- **Shrinks to a thin entry-point shim** that resolves `pi-sandbox/agents/<host>.yaml` and execs `node scripts/run-agent.mjs <host> --is-host`. Topology parsing, validation, group resolution, per-node overlay computation, PTY pool, multiplexer, focus controller, decisions queue, bus-tail buffer, launcher socket — all migrate into the `mesh-mux` peer extension (per ADR-0009).
- **`scripts/_lib/launcher-envelope.mjs`, `pty-pool.mjs`, `multiplexer.mjs`, `launcher-socket.mjs`, `decisions-queue.mjs`, `focus-controller.mjs`, `bus-tail.mjs`** become deps of the `mesh-mux` extension (loaded via `createRequire`, the same pattern `launcher-bridge` already uses for `launcher-socket.mjs`).
- **`pi-sandbox/.pi/extensions/_lib/topology.mjs`, `topology-validator.mjs`, `entry-resolver.mjs`, `group-membership.mjs`, `ref-resolver.mjs`** become libraries consumed by `mesh-mux` for `initial_mesh:` validation and group-reference resolution. Same logic, new caller; tests carry over.

### Extensions

- **`atomic-delegate.ts` is deleted.** Its spawn machinery, dispatch hook registry, and habitat-overlay computation move into a shared `_lib/peer-spawn.ts` consumed by the new `mesh-spawn.ts` extension. The end-of-turn batched-approval property migrates to the supervisor inbound rail (`supervisor.ts` / `_lib/supervisor-inbox.ts`): when multiple submissions land in one turn, they render as a single composite `respond_to_request` prompt rather than N sequential intercepts.
- **New extension `mesh-spawn.ts`** registers `mesh_spawn(recipe, name?, sandbox?, groups?, escalatesTo?, submitsWorkTo?, messagesWith?, acceptsWorkFrom?)` and `mesh_kill(name)` tools. The worker-side implementation is a thin client that round-trips `spawn-request` / `spawn-result` envelopes through the host's launcher socket (per ADR-0009).
- **New extension `mesh-mux.ts`** is the host-side counterpart. Self-gates on `--is-host`. Owns the PTY pool, xterm-headless virtual buffers, focus controller, decisions queue, bus-tail buffer; binds `${BUS_ROOT}/__launcher__.sock`; processes `spawn-request` envelopes; reads and acts on the host recipe's `initial_mesh:` at `session_start`.
- **`agent-bus.ts` renames to `peer-bus.ts`** with the bus tools renamed `peer_send` / `peer_inbox` / `peer_list` / `peer_call`. The wire protocol is unchanged. Group-aware `peer_send` (sender-side fan-out for list expansions) lives here.

### Bus protocol

- **New envelope kinds:**
  - `shutdown` — host instructs a peer to exit immediately. Receiving peer's bus extension calls `ctx.abort()` then `ctx.shutdown()`; host SIGTERMs after a 2s timeout.
  - `spawn-request` / `spawn-result` — worker → host on launcher socket; host → worker reply (per ADR-0009).
  - `mesh-update` — host broadcast (on launcher socket) of cohort membership changes, scoped per spawner namespace (per ADR-0008).
- **Existing envelope kinds are unchanged** in shape. Routing rules are unchanged: `submission`, `approval-request`, `revision-requested` flow point-to-point on the agent bus; the launcher socket carries control and spawn envelopes only.

### Migration

- 11 agent recipes need touching (`agents:` → `spawns:`; field renames per CONTEXT.md).
- 3 mesh files become host recipes (`pi-sandbox/agents/anon-grouped-mesh.yaml` etc.).
- `launch-mesh.mjs` shrinks to ~30 lines.
- `pi-sandbox/.pi/extensions/_lib/escalation.ts` `requestHumanApproval` continues to route to local `ctx.ui.confirm` for hosts; the `mesh-mux` extension owns the multiplexer that ensures the focused-peer convention surfaces the dialog correctly.
- Test migration is mechanical: existing `_lib/topology.test.ts`, `topology-validator.test.ts`, `group-membership.test.ts`, `ref-resolver.test.ts` continue to test the same logic, now consumed by `mesh-mux` rather than `launch-mesh.mjs`.
- Migration ships in independently safe slices: schema rename (`agents:` → `spawns:`) → `mesh-spawn.ts` extension landing alongside `atomic-delegate.ts` (both functional during transition) → host recipe migration → `atomic-delegate.ts` deletion → `launch-mesh.mjs` shim collapse → `pi-sandbox/meshes/` removal.
