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
| `delegate`, `agent-bus` peer messaging, supervisor rail, sub-agent safety | [`agents/multi-agent.md`](./agents/multi-agent.md) |
| Topology YAML — schema, groups, resolution, validation | [`agents/topology.md`](./agents/topology.md) |
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
agents: [deferred-writer]         # optional; recipes this agent may delegate to
```

> **Peer wiring is topology-only.** Recipes no longer accept `supervisor`, `submitTo`, `acceptedFrom`, or `peers` — the engine rejects them at parse time. All peer relationships are declared in the [topology YAML](./agents/topology.md) and reach the agent's Habitat via `--topology-overlay` at launch.

When the resolved Habitat (from the topology overlay) sets `submitTo`, the `deferred-*` end-of-turn flow ships the aggregated artifacts to that peer as a `submission` bus envelope instead of rendering a local approval dialog. The worker waits for an `approval-result` reply: on approval it logs `"submission applied by supervisor"` (the supervisor handles the actual writes); on rejection it discards the queue and logs the reason. Agents whose Habitat does not set `submitTo` keep the local UI-or-fail approval flow unchanged.

### `prompt:` and extension fragments

Tool-usage rules live next to the extensions that register the tools, not
in each recipe's `prompt:`. For each loaded extension `<name>`, the engine
looks for a sibling `<name>.prompt.md` in the extension's owning package
and, if present, prepends it to the system prompt that pi receives.
Recipes only need to describe the agent's role; the standard rules for
`deferred_write`, `deferred_edit`, `delegate`, etc. come from the
fragments.

One conditional fragment is gated by the engine so it doesn't appear
when irrelevant: `deferred-confirm.prompt.md` (apply order, atomic batch
semantics) is loaded only when at least one `deferred-*` tool extension
is active — baseline `deferred-confirm` itself is a no-op without one.

Final order seen by the model: engine-extension fragments → recipe-
extension fragments (including `atomic-delegate.prompt.md` when implicit
from `agents:`) → recipe `prompt:`. Edit a fragment to change behaviour
for every recipe that loads its extension; edit a recipe's `prompt:`
for that one agent only.

### Launch flags and implicit delegation

The engine registers six launch flags that `scripts/launch-mesh.mjs` and
`atomic-delegate` pass when spawning `pi --recipe` children: `--sandbox`,
`--task`, `--peer-name`, `--topology-overlay`, `--inherit-pty`, and
`--debug`. All six appear under "Extension CLI Flags" in `pi --help`.

When `agents:` is non-empty the engine also implicitly adds
`atomic-delegate` to `extensions:` and `delegate` to `tools:`. Explicit
duplicates in the recipe are fine. To disable delegation, drop the
`agents:` field entirely. See [`agents/multi-agent.md`](./agents/multi-agent.md)
for the delegate flow.

If a recipe lists an extension whose owning cluster package is not
installed, the engine refuses to start with a `pi install
npm:@agentfactory/<cluster>` hint rather than silently skipping the rail
— details in [`agents/rails-reference.md`](./agents/rails-reference.md).

## Per-instance names

Every agent instance — user-launched root or delegated child — is named
`<breed>-<shortName>`. The breed is a randomly-picked rabbit (or a hare
if `model:` is `LEAD_HARE_MODEL`); the short name comes from the
recipe's optional `shortName:` field, falling back to the recipe
filename stem. The slug is filesystem-safe and doubles as the bus
socket identity; the header prettifies it for display (so
`cottontail-writer` renders as "Cottontail Writer"). Breed pools live
in [`scripts/breed-names.json`](../scripts/breed-names.json) and the
generator + collision detection in
[`scripts/agent-naming.mjs`](../scripts/agent-naming.mjs).

Collision detection runs in two places: `atomic-delegate` tracks
in-flight sibling slugs in its pending-workers map so two parallel
`deferred-writer` children always get different breeds; `scripts/launch-mesh.mjs`
probes `${BUS_ROOT}/*.sock` so a second `peer-chatter` launched in
another terminal won't pick a breed that's already bound. `--peer-name
<override>` wins for both — useful when you want a stable peer name on
the bus.

## Where agent code lives

| Location | Behavior |
| --- | --- |
| `pi-sandbox/agents/<name>.yaml` | Recipe file for this repo; also loadable from `<cwd>/.pi/recipes/` (project-local) or `~/.pi/agent/recipes/` (global) |
| `packages/engine/agent/extensions/` | Engine-owned rails (`recipe-loader`, `agent-bus`, `supervisor`, `intercept`, etc.) — always present |
| `packages/deferred-rails/agent/extensions/` | Deferred-rails cluster (`deferred-confirm`, `deferred-write/edit/move/delete`) |
| `packages/containment-rails/agent/extensions/` | Containment-rails cluster (`sandbox`, `no-edit`) |
| `packages/ui-rails/agent/extensions/` | UI-rails cluster (`agent-header`, `agent-footer`, `no-startup-help`, `hide-extensions-list`) |
| `pi-sandbox/.pi/extensions/<name>.ts` | Project-local extension, auto-discovered by `npm run pi`; used during development of new extensions |
| `~/.pi/agent/extensions/<name>.ts` | Global extension, hot-reloadable via `/reload` |
| `pi -e ./path.ts` | One-off test load (not hot-reloadable) |
