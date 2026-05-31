# Composing agents — `pi --recipe`

Day-to-day, the way to launch a focused agent is `pi --recipe <name>`.
The `--recipe` flag is registered by the `@agentfactory/pi-engine`
extension package, which resolves the named recipe from
`<cwd>/.pi/recipes/` → `~/.pi/agent/recipes/` → bundled (project >
global > bundled), then configures the pi session with the recipe's
model, tools, extensions, and system prompt. Extensions come from the
installed engine and cluster packages, and every recipe gets the
engine-baseline rails automatically — see
[`agents/rails-reference.md`](./agents/rails-reference.md).

```sh
set -a; source models.env; set +a
pi --recipe deferred-writer                          # interactive, sandboxed to $PWD
pi --recipe deferred-writer --sandbox /tmp/scratch
pi --recipe deferred-writer -p "draft a README" --thinking off
```

## Map of this doc set

| Topic | Doc |
| --- | --- |
| Baseline extensions, cluster packages, missing-cluster error | [`agents/rails-reference.md`](./agents/rails-reference.md) |
| Worked recipes (deferred-writer, deferred-author, writer-foreman) | [`agents/worked-examples.md`](./agents/worked-examples.md) |
| `mesh_spawn`, `peer-bus` peer messaging, supervisor rail, sub-agent safety | [`agents/multi-agent.md`](./agents/multi-agent.md) |
| Host recipes (`--is-host`, `initial_mesh:`, when to author one) | [`agents/host-recipes.md`](./agents/host-recipes.md) |
| Debugging rails, unit tests, tmux integration, verifying a mesh | [`agents/testing.md`](./agents/testing.md) |

Design rationale lives in [`adr/`](./adr/).

## Recipe shape

```yaml
# pi-sandbox/agents/<name>.yaml  (also loadable from <cwd>/.pi/recipes/ or ~/.pi/agent/recipes/)
model: TASK_RABBIT_MODEL          # tier name resolved via env → ~/.pi/agent/models.json → bundled tier-defaults.json, or a literal model ID
description: Drafts files...      # optional; shown by agent-header in the TUI
prompt: |                         # the agent's role, prepended with extension fragments
  You are a careful drafter...
tools: [read, ls, grep, deferred_write]
extensions: [deferred-write]      # rails required by this recipe; owning cluster must be installed
skills: [pi-agent-builder]        # optional; resolved against <cwd>/.pi/skills/ → ~/.pi/agent/skills/ → bundled
escalatesTo: lead                 # optional; peer this agent escalates approvals to
submitsWorkTo: collector          # optional; peer this agent ships submissions to
acceptsWorkFrom: [lead]           # optional; peers allowed to ship approval-request / submission
messagesWith: [lead, w1]          # optional; peers this agent may address
spawns: [deferred-writer]         # optional; recipes this agent may spawn via mesh_spawn
initial_mesh:                     # optional; host-recipe block — pre-spawns peers at session_start
  - recipe: deferred-writer
    groups: [workers]
    task: "Wait for instructions from the host."
```

### Implicit-wire rules

The engine enforces three automatic wiring rules at recipe parse time:

- **`spawns:` non-empty** ⇒ the engine auto-loads the `mesh-spawn` extension and adds `mesh_spawn`/`mesh_kill` to active tools. No need to list these in `tools:` or `extensions:` explicitly (source: `packages/engine/agent/extensions/recipe-loader.ts` and `mesh-spawn.ts`).
- **`tools: [mesh_spawn]` without `spawns:`** ⇒ recipe rejected at parse time with an error — `mesh_spawn` requires an explicit allowlist.
- **`initial_mesh:` non-empty** ⇒ the recipe must be launched with `--is-host` (or `npm run mesh -- <recipe>`, which sets it automatically). Without `--is-host`, the `mesh-mux` extension is a silent no-op and `initial_mesh:` entries are never processed.

When the resolved Habitat sets `submitsWorkTo`, the `deferred-*` end-of-turn flow ships the aggregated artifacts to that peer as a `submission` bus envelope instead of rendering a local approval dialog. The worker waits for an `approval-result` reply: on approval it logs `"submission applied by supervisor"` (the supervisor handles the actual writes); on rejection it discards the queue and logs the reason. Agents whose Habitat does not set `submitsWorkTo` keep the local UI-or-fail approval flow unchanged.

### `prompt:` and extension fragments

Tool-usage rules live next to the extensions that register the tools, not
in each recipe's `prompt:`. For each loaded extension `<name>`, the engine
looks for a sibling `<name>.prompt.md` in the extension's owning package
and, if present, prepends it to the system prompt that pi receives.
Recipes only need to describe the agent's role; the standard rules for
`deferred_write`, `deferred_edit`, `mesh_spawn`, etc. come from the
fragments. The mesh subsystem follows the same pattern: `mesh-spawn.prompt.md`
(tool usage rules for `mesh_spawn`/`mesh_kill`) and `mesh-mux.prompt.md`
(host orientation: initial peers are ready, use `peer_send`/`peer_call`) ride
this same fragment mechanism.

One conditional fragment is gated by the engine so it doesn't appear
when irrelevant: `deferred-confirm.prompt.md` (apply order, atomic batch
semantics) is loaded only when at least one `deferred-*` tool extension
is active — baseline `deferred-confirm` itself is a no-op without one.

Final order seen by the model: engine-extension fragments → recipe-
extension fragments → recipe `prompt:`. Edit a fragment to change behaviour
for every recipe that loads its extension; edit a recipe's `prompt:`
for that one agent only.

### Launch flags

The engine registers eight launch flags (see `recipe-loader.ts:137-168`).
All eight appear under "Extension CLI Flags" in `pi --help`.

| Flag | Description |
| --- | --- |
| `--sandbox <path>` | Absolute path to the sandbox / working directory |
| `--task <text>` | Per-instance role context appended to the system prompt |
| `--peer-name <name>` | Override the agent's bus socket identity and display name |
| `--topology-overlay <json>` | JSON peer-relationship blob from the launcher |
| `--peer-bus <dir>` | Override the peer bus root directory |
| `--inherit-pty` | Skip nested PTY allocation (session's stdio is already in a managed PTY) |
| `--debug` | Enable verbose diagnostic logging in rails |
| `--is-host` | Mark the session as a mesh host; binds the launcher socket; processes `initial_mesh:` |

`--is-host` is **not** forwarded by `buildRecipeChildArgv` to children — it is a host-only
launch property. The other seven flags are forwarded as needed by `mesh-mux` / `mesh-spawn`.

See [`agents/multi-agent.md`](./agents/multi-agent.md) for the mesh_spawn flow.
See [`agents/host-recipes.md`](./agents/host-recipes.md) for the `--is-host` / `initial_mesh:` pattern.

### Group namespacing

Spawner-scoped groups let recipes tag peers with logical roles. The reference grammar:

| Syntax | Meaning |
| --- | --- |
| `@<group>` | All peers in the named group under the same spawner |
| `@<group>:<recipe>` | Peers in the named group whose recipe is `<recipe>` |
| `@<recipe>` | Peers in this agent's own groups whose recipe is `<recipe>` (short for `@$myGroups:<recipe>`) |
| `@$myGroups` | All peers in any group this agent itself belongs to |
| `@$myGroups:<recipe>` | Peers in this agent's own groups whose recipe is `<recipe>` |

`@_default` is the implicit group for ungrouped peers. See
`pi-sandbox/agents/grouped-mesh.yaml` for a live example that uses
`messagesWith: ["@reviewers"]` to wire workers to the reviewer group.
All `@ref` expressions are resolved to concrete peer names before the
`--topology-overlay` JSON is built; the bus always sees concrete names.

If a recipe lists an extension whose owning cluster package is not
installed, the engine refuses to start with a `pi install
npm:@agentfactory/<cluster>` hint rather than silently skipping the rail
— details in [`agents/rails-reference.md`](./agents/rails-reference.md).

## Per-instance names

Every agent instance — user-launched root or spawned child — is named
`<breed>-<shortName>`. The breed is a randomly-picked rabbit (or a hare
if `model:` is `LEAD_HARE_MODEL`); the short name comes from the
recipe's optional `shortName:` field, falling back to the recipe
filename stem. The slug is filesystem-safe and doubles as the bus
socket identity; the header prettifies it for display (so
`cottontail-writer` renders as "Cottontail Writer"). Breed pools live
in [`scripts/breed-names.json`](../scripts/breed-names.json) and the
generator + collision detection in
[`scripts/agent-naming.mjs`](../scripts/agent-naming.mjs).

Collision detection runs in two places: `mesh-spawn` tracks
in-flight sibling slugs in its registry so two parallel
`deferred-writer` children always get different breeds; `mesh-mux`
probes `${BUS_ROOT}/*.sock` so a second `peer-chatter` launched in
another terminal won't pick a breed that's already bound. `--peer-name
<override>` wins for both — useful when you want a stable peer name on
the bus.

## Where agent code lives

| Location | Behavior |
| --- | --- |
| `pi-sandbox/agents/<name>.yaml` | Recipe file for this repo; also loadable from `<cwd>/.pi/recipes/` (project-local) or `~/.pi/agent/recipes/` (global) |
| `packages/engine/agent/extensions/` | Engine-owned rails (`recipe-loader`, `peer-bus`, `mesh-mux`, `mesh-spawn`, `supervisor`, `intercept`, etc.) — always present |
| `packages/deferred-rails/agent/extensions/` | Deferred-rails cluster (`deferred-confirm`, `deferred-write/edit/move/delete`) |
| `packages/containment-rails/agent/extensions/` | Containment-rails cluster (`sandbox`, `no-edit`) |
| `packages/ui-rails/agent/extensions/` | UI-rails cluster (`agent-header`, `agent-footer`, `no-startup-help`, `hide-extensions-list`) |
| `pi-sandbox/.pi/extensions/<name>.ts` | Project-local extension, auto-discovered by `npm run pi`; used during development of new extensions |
| `~/.pi/agent/extensions/<name>.ts` | Global extension, hot-reloadable via `/reload` |
| `pi -e ./path.ts` | One-off test load (not hot-reloadable) |
