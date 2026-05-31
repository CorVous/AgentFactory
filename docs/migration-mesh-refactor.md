# Migration plan: mesh-extensions refactor (ADRs 0007–0009)

> **SUPERSEDED (launcher slices):** The launcher portions of this migration
> plan — specifically the description of `npm run agent`, `scripts/run-agent.mjs`,
> and the `--is-host` flag in Slices 4–5 — are superseded by
> [ADR-0010](./adr/0010-pi-recipe-replaces-wrapper-launcher.md). The single-agent
> launcher is now `pi --recipe <name>` (registered by `@agentfactory/pi-engine`);
> `run-agent.mjs` is deleted; `npm run mesh` spawns nodes as `pi --recipe`
> children via `buildRecipeChildArgv` in
> `packages/engine/agent/lib/child-spawn.mjs`. The mesh-extensions refactor
> (ADRs 0007–0009) itself — vocabulary renames, `mesh-spawn`, group scoping,
> host recipe pattern — remains a future epic; only its launcher slices rebase
> onto `pi --recipe` rather than the now-deleted wrapper.

This document sketches the vertical-slice sequence for migrating from the current two-artifact (recipe + topology) world to the unified host-grown-mesh world described in ADR-0007, ADR-0008, and ADR-0009. Each slice is independently mergeable and leaves the system functional; the legacy `delegate` / topology paths survive until the slice that explicitly removes them.

## Slice 1 — Vocabulary rename (no behavior change)

Mechanical search-and-replace plus schema-validation updates. The runner accepts both old and new names during this slice (deprecation warnings on old) so recipe authors and tests can migrate gradually. **Lands first because every subsequent slice depends on the new vocabulary.**

- Recipe field renames: `agents:` → `spawns:`, `acceptedFrom:` → `acceptsWorkFrom:`, `peers:` → `messagesWith:`, `submitTo:` → `submitsWorkTo:`. Habitat field rename: `agentName:` → `instanceName:`, `type:` → `recipe:`. Symbolic rename: `$self` → `$spawner`.
- Topology field renames: `supervisor:` → `escalatesTo:` (when used as a habitat overlay; the topology-time field also renames in this slice and dies in slice 7).
- Bus tool renames: `agent_send` → `peer_send`, `agent_inbox` → `peer_inbox`, `agent_list` → `peer_list`, `agent_call` → `peer_call`. Extension `agent-bus.ts` → `peer-bus.ts`.
- CLI flag renames: `--agent-bus` → `--peer-bus`, `--agent-name` → `--peer-name`. Env var `PI_AGENT_BUS_ROOT` → `PI_PEER_BUS_ROOT`, `PI_AGENT_NAME` → `PI_PEER_NAME` (deprecation removes them per ADR-0006).
- Topology field `initial_spawn:` → `initial_mesh:` (no semantic change yet — still parsed by topology validator).
- Bus envelope kind `group-update` → `mesh-update` (no shape change).
- 11 agent recipes touched; 3 mesh files touched; ~12 extension files touched; tests update mechanically.

## Slice 2 — `mesh-spawn` extension lands alongside `atomic-delegate`

New extension `mesh-spawn.ts` ships with `mesh_spawn(recipe, name?, …)` and `mesh_kill(name)` tools. `atomic-delegate.ts` and the `delegate` tool continue to work; the two extensions coexist. Spawn machinery extracts to `_lib/peer-spawn.ts` consumed by both. **Recipes opt into the new model by declaring `spawns:` (object form with wiring) instead of `agents:` and listing `mesh_spawn` in tools (or relying on the new implicit-wire rule).** Existing `delegate`-based recipes are unchanged.

- New file: `pi-sandbox/.pi/extensions/mesh-spawn.ts`, `mesh-spawn.prompt.md`, `_lib/peer-spawn.ts`.
- Implicit-wire rule: `spawns:` non-empty ⇒ `mesh-spawn` extension loaded, `mesh_spawn`/`mesh_kill` added to tools.
- Inverse rejection: `tools: [mesh_spawn]` without `spawns:` ⇒ recipe-parse error.
- Refactor: `atomic-delegate.ts`'s `runAtomicDelegate` factors into `_lib/peer-spawn.ts` (renamed/restructured but covered by existing tests).
- New unit tests: `mesh-spawn` parameter validation, recipe-allowlist enforcement.
- The `shutdown` envelope kind lands here so `mesh_kill` has somewhere to dispatch; the receiving side is implemented in `peer-bus.ts` (bus extension).

## Slice 3 — Spawner-scoped groups + visibility scoping

Implements ADR-0008. Recipes can declare `groups:` on `initial_mesh:` entries and as a `mesh_spawn()` parameter. The cohort registry on the host's `mesh-mux` extension grows from flat to `Map<spawnerName, Map<groupName, peer[]>>`. The `cohort-tracker` logic (folded into `peer-bus.ts`) maintains per-peer caches via `mesh-update` envelopes. Visibility scoping pre-filters `peer_list` and `mesh-update` broadcasts.

- New reference grammar: `@<group>:<recipe>`, `@<group>`, `@<recipe>`, `@$myGroups`, `@$myGroups:<recipe>`. The reference parser lives in `_lib/peer-spawn.ts`.
- `peer-bus.ts` gains sender-side fan-out for list-field group references (ADR-0008's chosen semantic).
- `peer-bus.ts` gains the unknown-sender lookup endpoint to resolve race windows.
- New unit tests: group resolution under various spawner namespaces, visibility filtering, race-window handling.
- The `@_default` implicit group is the fallback for ungrouped peers.
- This slice's behavior is *additive* — recipes that don't declare groups continue to work via `@_default`.

## Slice 4 — Recipe-as-host: `--is-host` flag + new `mesh-mux` extension

Implements ADR-0009 plus the runner's `--is-host` flag. The new `mesh-mux` extension self-gates on `--is-host`, binds the launcher socket, and processes the recipe's `initial_mesh:` at session_start. The legacy `launch-mesh.mjs` continues to work (it uses its own PTY pool and launcher socket); a recipe launched with `--is-host` via `npm run agent` gets the same machinery in-extension.

- New file: `pi-sandbox/.pi/extensions/mesh-mux.ts`, `mesh-mux.prompt.md`.
- `mesh-mux.ts` consumes `scripts/_lib/{pty-pool,multiplexer,launcher-socket,decisions-queue,focus-controller,bus-tail}.mjs` via `createRequire`.
- Spawn protocol envelopes: `spawn-request` and `spawn-result` lands in `scripts/_lib/launcher-envelope.mjs`.
- `mesh-spawn.ts`'s `mesh_spawn` tool implementation switches from direct `child_process.spawn` to launcher-socket round-trip via `launcher-bridge`.
- The host recipe pattern is now demonstrated by a new example: `pi-sandbox/agents/mesh-host-example.yaml` with both `spawns:` and `initial_mesh:` populated.
- During this slice, both `npm run mesh -- topology.yaml` and `npm run agent -- host-recipe` work; they share the underlying spawn protocol.

## Slice 5 — `launch-mesh.mjs` shrinks to a thin shim

`launch-mesh.mjs` becomes ~30 lines: parse the topology argument, find the unique top supervisor (host), exec `node scripts/run-agent.mjs <host-recipe> --is-host`. All topology validation, group resolution, per-node overlay computation that today's `launch-mesh.mjs` does is now redundant with `mesh-mux.ts`'s in-extension equivalents — those code paths in `launch-mesh.mjs` delete in this slice.

- The validation libs (`_lib/topology-validator.mjs`, `topology.mjs`, `entry-resolver.mjs`, `group-membership.mjs`, `ref-resolver.mjs`) get a *second* consumer (the `mesh-mux` extension); their unit tests still pass.
- `pi-sandbox/meshes/<name>.yaml` files migrate to `pi-sandbox/agents/<name>.yaml` host recipes one at a time. Each migration replaces topology peer relationships with recipe `spawns:` blocks and topology `nodes:` with `initial_mesh:`. The original mesh file remains until all references migrate.
- `npm run mesh` in this slice is functionally equivalent to `npm run agent -- <host-recipe>` for any topology that has been migrated.

## Slice 6 — Delete `atomic-delegate.ts` and the `delegate` tool

Remove `pi-sandbox/.pi/extensions/atomic-delegate.ts`, `atomic-delegate.prompt.md`, and the `delegate` tool registration. Migrate `writer-foreman.yaml` (and any other recipe still using `delegate`) to use `mesh_spawn` + `peer_send` + `mesh_kill`. The end-of-turn batched-approval property migrates to the supervisor inbound rail (`_lib/supervisor-inbox.ts`): when multiple submissions land in one turn, render them as one composite `respond_to_request` prompt.

- Test migration: `_lib/atomic-delegate.test.ts` either deletes (if its coverage is subsumed by `_lib/peer-spawn.test.ts`) or refactors to test `peer-spawn`.
- Recipe migration: `writer-foreman.yaml` rewrites with the new pattern; its prompt fragment may need updating to describe the multi-tool-call flow.
- Documentation: remove `delegate` references from `docs/agents/multi-agent.md` and `docs/agents/worked-examples.md` (and any residual mention in `docs/agents.md`) plus skill prompt fragments; CONTEXT.md is already updated (per the synthesis batch).

## Slice 7 — Delete `pi-sandbox/meshes/` and topology validator entry-points

Once every mesh file has migrated to a host recipe (slice 5) and `delegate` is gone (slice 6), the mesh-file directory and its dedicated entry-points delete. `npm run mesh` becomes a deprecated alias for `npm run agent --` (with `--is-host` set automatically) and prints a deprecation warning, or removes entirely.

- Delete: `pi-sandbox/meshes/` directory, `scripts/launch-mesh.mjs` (or shrink to a one-liner deprecation wrapper).
- The validation libs (`topology-validator.mjs` etc.) survive as `mesh-mux`'s consumers; rename them to `_lib/spawn-resolver.mjs` etc. if appropriate.
- `package.json` `mesh` script either deletes or aliases to `agent`.
- Old field aliases from slice 1 (`agents:`, `acceptedFrom:`, `peers:`, etc.) deprecate-error in this slice — recipes that still use them fail to parse with a clear pointer to the rename.

## Slice 8 — Documentation refresh

After the code is settled:
- Rewrite `docs/agents.md`'s "Composing agents" and "Recipe shape" sections to describe `spawns:`, `initial_mesh:`, group namespacing, and the implicit-wire rules.
- Add `docs/agents/host-recipes.md` explaining the host-vs-worker distinction and when to author each.
- Update `docs/agents/issue-tracker.md`, `docs/conventions.md`, `docs/repo-layout.md` for the renamed paths and tool names.
- Skill prompt fragments (`pi-sandbox/skills/pi-agent-builder/references/`) refresh to match the new vocabulary.
- Smoke-test scenarios from `docs/agents/testing.md`'s "Verifying the multi-agent rails" section update to demonstrate host recipes rather than topology launches.

## Open questions deferred to follow-up ADRs

- **Live `supervisor:` rebinding on death.** When a peer's resolved `submitsWorkTo:` target dies, the surviving peer is left pointing at a dead name. Current behavior: subsequent submissions fail with "peer offline." Future: rebind via cohort tracker. Triggered by real failure cases, not v1.
- **Cross-tier group references** (`@$myChildren:writer`, `@$mySpawner:reviewer`). Out of scope per ADR-0008. Revisit if a real use case emerges.
- **Pooled top supervisors** (multiple meshes running together with shared escalation). Out of scope per ADR-0005. ADR-0008's spawner-scoping doesn't preclude future pooling.
- **`mesh_spawn_cohort([recipes])`** as a single-tool-call cohort spawner so `$siblings` resolution is symmetric for runtime spawns (today only `initial_mesh:` gets symmetric `$siblings`). Optimization, not correctness.

## Total scope estimate

- 9 ADR / docs files written or amended (this synthesis).
- ~50 source files touched across all slices.
- ~15 unit-test files touched, no major test deletions.
- 14 recipes (agents + meshes) migrated.
- Net code delta: roughly neutral or slightly negative (`launch-mesh.mjs` shrinks ~530 lines; `atomic-delegate.ts` deletes 373 lines; offset by `mesh-mux.ts` and `mesh-spawn.ts` of comparable size).
