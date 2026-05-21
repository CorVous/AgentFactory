# Migration plan: mesh-extensions refactor (ADRs 0007–0009)

> **Rebased onto ADR-0010 (2026-05-21).** This plan originally targeted the
> `scripts/run-agent.mjs` wrapper launcher.
> [ADR-0010](./adr/0010-pi-recipe-replaces-wrapper-launcher.md) has since
> deleted that launcher: `pi --recipe <name>` is now the sole single-agent
> launcher (`--recipe` is a flag on the always-on `@agentfactory/pi-engine`
> extension), AgentFactory ships as pi packages (`engine` + `deferred-rails`
> + `containment-rails` + `ui-rails`), and the mesh subsystem folds into the
> `engine` package rather than being a separate cluster. The slice bodies
> below assume that post-ADR-0010 world. This 7-slice sequence supersedes the
> original 8-slice plan (still reflected in PRD #117 and slice issues
> #118–#130, which predate ADR-0010 and need re-publishing before the epic
> starts).

This document sequences the vertical slices for migrating from the current
two-artifact (recipe + topology) world to the unified host-grown-mesh world
described in ADR-0007, ADR-0008, and ADR-0009. Each slice is independently
mergeable and leaves the system functional; the legacy `delegate` and
topology paths survive until the slice that explicitly removes them.

## Slice 1 — Vocabulary rename (hard cut)

Mechanical search-and-replace plus schema-validation updates, applied as a
**single hard cut**: every in-repo recipe, extension, and test moves to the
new vocabulary in this slice, and the engine recipe-loader's recipe parser
rejects the old field names immediately with an error that names the new
field. There is no dual-name deprecation window — `run-agent.mjs` (which
would have hosted the alias logic) is deleted, the repo has a single user,
and a loud parse error is a better migration aid than a silently-ignored
warning. **Lands first because every subsequent slice depends on the new
vocabulary.**

- Recipe field renames: `agents:` → `spawns:`, `acceptedFrom:` → `acceptsWorkFrom:`, `peers:` → `messagesWith:`, `submitTo:` → `submitsWorkTo:`. Habitat field renames: `agentName:` → `instanceName:`, `type:` → `recipe:`. Symbolic rename: `$self` → `$spawner`.
- Topology field `supervisor:` → `escalatesTo:`. The same rename applies to the `--topology-overlay` JSON keys parsed by the recipe-loader; the topology-file field renames here and the topology file itself is retired in Slice 5.
- Bus tool renames: `agent_send` → `peer_send`, `agent_inbox` → `peer_inbox`, `agent_list` → `peer_list`, `agent_call` → `peer_call`. Extension `agent-bus.ts` → `peer-bus.ts` (in `packages/engine/agent/extensions/`).
- CLI flag rename: `--agent-bus` → `--peer-bus`. (`--agent-name` → `--peer-name` already shipped — the engine recipe-loader registers `--peer-name` today. The `PI_AGENT_BUS_ROOT` / `PI_AGENT_NAME` env vars were already removed; only stale comments remain to scrub.)
- Topology field `initial_spawn:` → `initial_mesh:` (no semantic change yet — still parsed by the topology validator).
- Bus envelope kind `group-update` → `mesh-update` (no shape change).
- Old-name rejection: the recipe-loader parser maps each retired YAML field to a `recipe-loader: '<old>' renamed to '<new>'` parse error; old tool names simply fail the recipe's `tools:` allowlist resolution. (This is the check the original 8-slice plan deferred to its Slice 7; with a hard cut it lands here.)
- 11 agent recipes + 3 mesh files touched; the mesh/bus extension files (now under `packages/engine/`) and their tests update mechanically.

## Slice 2 — `mesh-spawn` extension lands alongside `atomic-delegate`

New extension `mesh-spawn.ts` ships with `mesh_spawn(recipe, name?, …)` and
`mesh_kill(name)` tools. `atomic-delegate.ts` and the `delegate` tool
continue to work; the two extensions coexist. Per ADR-0010 the mesh
subsystem lives in the `engine` package, so the new extension is authored
in `packages/engine/agent/extensions/` from the start. Recipes opt into the
new model by declaring `spawns:` (object form with wiring) instead of
`agents:` and listing `mesh_spawn` in tools (or relying on the implicit-wire
rule). Existing `delegate`-based recipes are unchanged.

- New files: `packages/engine/agent/extensions/mesh-spawn.ts`, `mesh-spawn.prompt.md`, and `packages/engine/agent/lib/peer-spawn.ts`.
- `peer-spawn.ts` consumes the existing `packages/engine/agent/lib/child-spawn.mjs` (`buildRecipeChildArgv`, `resolvePiBin`) rather than re-implementing argv building — #157 already extracted the argv builder there. `peer-spawn.ts` adds the parts not yet extracted: the dispatch-hook registry, habitat-overlay computation, and cleanup-on-host-exit.
- Implicit-wire rule: `spawns:` non-empty ⇒ `mesh-spawn` extension loaded, `mesh_spawn` / `mesh_kill` added to tools.
- Inverse rejection: `tools: [mesh_spawn]` without `spawns:` ⇒ recipe-parse error.
- Refactor: `atomic-delegate.ts`'s `runAtomicDelegate` factors into `peer-spawn.ts`, covered by the existing tests (which move into the engine lib alongside it).
- New unit tests: `mesh-spawn` parameter validation, recipe-allowlist enforcement.
- The `shutdown` envelope kind lands here so `mesh_kill` has somewhere to dispatch; the receiving side is implemented in `peer-bus.ts`.

> `atomic-delegate.ts` is still physically a project-local extension under
> `pi-sandbox/.pi/extensions/` even though `rail-packages.ts` already maps it
> to the `engine` package — a loose end from #157. It is deleted outright in
> Slice 6, so this slice does not relocate it.

## Slice 3 — Spawner-scoped groups + visibility scoping

Implements ADR-0008. Recipes can declare `groups:` on `initial_mesh:`
entries and as a `mesh_spawn()` parameter. The cohort registry on the host's
`mesh-mux` extension grows from flat to `Map<spawnerName, Map<groupName,
peer[]>>`. The `cohort-tracker` logic (folded into `peer-bus.ts`) maintains
per-peer caches via `mesh-update` envelopes. Visibility scoping pre-filters
`peer_list` and `mesh-update` broadcasts.

- New reference grammar: `@<group>:<recipe>`, `@<group>`, `@<recipe>`, `@$myGroups`, `@$myGroups:<recipe>`. The reference parser lives in `packages/engine/agent/lib/peer-spawn.ts`.
- `group-membership.mjs` and `ref-resolver.mjs` move from `pi-sandbox/.pi/extensions/_lib/` into `packages/engine/agent/lib/`; same logic, new consumer (the spawn-time resolver), tests move with them.
- `peer-bus.ts` gains sender-side fan-out for list-field group references (ADR-0008's chosen semantic).
- `peer-bus.ts` gains the unknown-sender lookup endpoint to resolve race windows.
- New unit tests: group resolution under various spawner namespaces, visibility filtering, race-window handling.
- The `@_default` implicit group is the fallback for ungrouped peers.
- This slice's behavior is *additive* — recipes that don't declare groups continue to work via `@_default`.

## Slice 4 — Recipe-as-host: `--is-host` flag + `mesh-mux` extension

Implements ADR-0009 plus an `--is-host` launch flag. `--is-host` becomes the
8th flag registered by the engine recipe-loader (joining `--recipe`,
`--sandbox`, `--task`, `--topology-overlay`, `--inherit-pty`, `--debug`,
`--peer-name`). The new `mesh-mux` extension — in the `engine` package per
ADR-0010 — self-gates on `--is-host`, binds the launcher socket, and
processes the recipe's `initial_mesh:` at `session_start`. During this slice
the legacy `launch-mesh.mjs` still works (it owns its own PTY pool and
launcher socket); a recipe launched as `pi --recipe <host> --is-host` gets
the same machinery in-extension.

- New files: `packages/engine/agent/extensions/mesh-mux.ts`, `mesh-mux.prompt.md`.
- `mesh-mux.ts` consumes `pty-pool`, `multiplexer`, `launcher-socket`, `decisions-queue`, `focus-controller`, and `bus-tail`. Those modules move into `packages/engine/agent/lib/` in this slice — an engine-package extension cannot `createRequire` from `scripts/_lib/` once the package is installed to `~/.pi`. (`launcher-socket.mjs` and `launcher-envelope.mjs` already have engine-package copies from #157; the stale `scripts/_lib/` duplicates are deleted with `launch-mesh.mjs` in Slice 5.) `topology.mjs`, `topology-validator.mjs`, and `entry-resolver.mjs` also move into the engine lib for `initial_mesh:` validation.
- `--is-host` is set by whoever launches the host (Slice 5's `npm run mesh` wrapper passes it explicitly); children spawned via `mesh_spawn` / `atomic-delegate` never receive it, so the host-vs-worker distinction is purely a launch-flag property — never recipe content (per ADR-0009).
- Spawn protocol envelopes `spawn-request` and `spawn-result` land in `packages/engine/agent/lib/launcher-envelope.mjs`.
- `mesh-spawn.ts`'s `mesh_spawn` tool switches from direct child spawn to a launcher-socket round-trip via `launcher-bridge`.
- The host recipe pattern is demonstrated by a new example: `pi-sandbox/agents/mesh-host-example.yaml` with both `spawns:` and `initial_mesh:` populated.
- During this slice both `npm run mesh -- topology.yaml` (legacy `launch-mesh.mjs`) and `pi --recipe <host> --is-host` work; they share the underlying spawn protocol.

## Slice 5 — Retire the topology artifact

The merged "topology artifact disappears" slice (the original plan's
Slices 5 and 7). Once `mesh-mux` (Slice 4) can grow a mesh from a host
recipe, the topology YAML, its launcher script, and its `npm run mesh`
entry point have nothing left to do.

- Each `pi-sandbox/meshes/<name>.yaml` migrates to a `pi-sandbox/agents/<name>.yaml` host recipe: topology peer relationships become recipe `spawns:` blocks; topology `nodes:` become `initial_mesh:` entries. Migrate one at a time so each step is independently verifiable.
- Once the last mesh file migrates, `pi-sandbox/meshes/` is deleted.
- `scripts/launch-mesh.mjs` and `scripts/launch-mesh.test.mjs` are deleted **outright** — not shrunk to a shim. All topology validation, group resolution, and per-node overlay computation they did is now redundant with `mesh-mux`'s in-extension equivalents.
- `npm run mesh` becomes a `package.json` bash wrapper mirroring the existing `pi` script — `bash -c '… exec pi --recipe "$1" --is-host …'` — with no `.mjs` file behind it. (ADR-0007's "delegate to `npm run agent`" framing is moot: `npm run agent` was deleted by ADR-0010.)
- The stale `scripts/_lib/` copies of `launcher-socket.mjs` and `launcher-envelope.mjs` (byte-identical duplicates of the engine-package versions) are deleted along with `launch-mesh.mjs`, their last consumer.
- The validation libraries moved into the engine in Slice 4 keep their tests; an optional cosmetic rename (`topology-validator.mjs` → `spawn-validator.mjs`, etc.) can ride along or be skipped as churn.

## Slice 6 — Delete `atomic-delegate` and the `delegate` tool

Remove `atomic-delegate.ts`, `atomic-delegate.prompt.md`, and the `delegate`
tool registration. `atomic-delegate.ts` is the last extension still living
project-local under `pi-sandbox/.pi/extensions/` (with its
`_lib/atomic-delegate.ts` helper); deleting it also clears that #157 loose
end. Migrate every recipe still using `delegate` — `writer-foreman.yaml`,
`delegator.yaml`, `mesh-authority.yaml` — to the `mesh_spawn` + `peer_send`
+ `mesh_kill` pattern.

- The end-of-turn batched-approval property migrates to the supervisor inbound rail (`packages/engine/agent/lib/supervisor-inbox.ts`): when multiple submissions land in one turn, render them as one composite `respond_to_request` prompt.
- Test migration: `_lib/atomic-delegate.test.ts` either deletes (if its coverage is subsumed by `peer-spawn.test.ts`) or refactors to test `peer-spawn`.
- Recipe migration: `writer-foreman.yaml` and the other `delegate` users rewrite with the new pattern; their prompt fragments update to describe the multi-tool-call flow.
- Documentation: remove `delegate` references from `docs/agents.md` and skill prompt fragments.

## Slice 7 — Documentation refresh

After the code is settled:
- Rewrite `docs/agents.md`'s "Composing agents" and "Recipe shape" sections to describe `spawns:`, `initial_mesh:`, group namespacing, and the implicit-wire rules.
- Add `docs/agents/host-recipes.md` explaining the host-vs-worker distinction and when to author each.
- Update `docs/repo-layout.md`, `docs/conventions.md`, and `docs/agents/issue-tracker.md` for the renamed paths and tool names.
- Skill prompt fragments (`pi-sandbox/skills/pi-agent-builder/references/`) refresh to match the new vocabulary.
- Smoke-test scenarios from `docs/agents.md`'s "Verifying the multi-agent rails" section update to demonstrate host recipes rather than topology launches.
- This migration doc is marked complete and points readers at the live `docs/agents.md`.

## Open questions deferred to follow-up ADRs

- **Live `submitsWorkTo:` rebinding on death.** When a peer's resolved `submitsWorkTo:` target dies, the surviving peer is left pointing at a dead name. Current behavior: subsequent submissions fail with "peer offline." Future: rebind via cohort tracker. Triggered by real failure cases, not v1.
- **Cross-tier group references** (`@$myChildren:writer`, `@$mySpawner:reviewer`). Out of scope per ADR-0008. Revisit if a real use case emerges.
- **Pooled top supervisors** (multiple meshes running together with shared escalation). Out of scope per ADR-0005. ADR-0008's spawner-scoping doesn't preclude future pooling.
- **`mesh_spawn_cohort([recipes])`** as a single-tool-call cohort spawner so `$siblings` resolution is symmetric for runtime spawns (today only `initial_mesh:` gets symmetric `$siblings`). Optimization, not correctness.

## Total scope estimate

Approximate — refresh before execution.

- 7 vertical slices.
- ~50 source files touched, now concentrated under `packages/engine/` and `pi-sandbox/agents/` rather than `scripts/` + `pi-sandbox/.pi/extensions/`.
- ~15 unit-test files touched; no major test deletions (topology / spawn tests move into the engine package with their modules).
- 11 agent recipes + 3 mesh files migrated.
- Net code delta: negative. `launch-mesh.mjs` (~555 lines) and `launch-mesh.test.mjs` are deleted outright — not shrunk to a shim, per ADR-0010's deletion of the wrapper-launcher model. `atomic-delegate.ts` (~370 lines) plus `_lib/atomic-delegate.ts` (~180 lines) delete. The new `mesh-mux.ts`, `mesh-spawn.ts`, and `peer-spawn.ts` are partly offset by reusing the already-extracted `child-spawn.mjs` and the relocated `_lib/` modules.
