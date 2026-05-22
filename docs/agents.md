# Composing agents — `pi --recipe`

Day-to-day, the way to launch a focused agent is `pi --recipe <name>`.
The `--recipe` flag is registered by the `@agentfactory/pi-engine`
extension package, which resolves the named recipe from
`<cwd>/.pi/recipes/` → `~/.pi/agent/recipes/` → bundled (project >
global > bundled), then configures the pi session with the recipe's
model, tools, extensions, and system prompt. Extensions come from the
installed engine and cluster packages. Every agent launched via a
recipe gets the following engine-baseline extensions automatically:

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

Collision detection runs in two places: `mesh-spawn` tracks
in-flight sibling slugs in its registry so two parallel
`deferred-writer` children always get different breeds; `mesh-mux`
probes `${BUS_ROOT}/*.sock` so a second `peer-chatter` launched in
another terminal won't pick a breed that's already bound. `--peer-name
<override>` wins for both — useful when you want a stable peer name on
the bus.

- `sandbox` — blocks `bash` outright and rejects any path-bearing tool
  call whose `path` resolves outside the sandbox root. The set of
  path-bearing tools is discovered at session start from
  `pi.getAllTools()` (any tool whose schema declares `path: string`),
  with a static fallback of `{read, write, edit, ls, grep, find}` for
  the installed pi 0.75 built-ins. Owns the `--sandbox-root <path>`
  flag (read by `agent-footer`, `deferred-write`, and `no-edit` via
  `pi.getFlag`); falls back to `ctx.cwd` when the flag is unset.
  Ships in `@agentfactory/containment-rails`.
- `no-startup-help` — suppresses pi's default startup header (logo,
  keybinding cheatsheet, onboarding tips) since most of those keybindings
  reference features focused agents don't use. Ships in
  `@agentfactory/ui-rails`.
- `agent-header` — replaces the (now-empty) header with a banner that
  shows the agent's full display name (bold accent) — the breed from
  the `<breed>-<shortName>` slug joined with the prettified recipe
  filename, e.g. `Cottontail Deferred Writer` — optionally suffixed
  dim with the model tier (e.g. `· Task Rabbit`), and the recipe's
  `description:` field on the next line (dim). Ships in
  `@agentfactory/ui-rails`.
- `agent-footer` — replaces pi's default footer. Line 1 shows the
  sandbox root on the left and the comma-separated active tools (from
  `pi.getActiveTools()`, i.e. the recipe's `tools:` allowlist plus any
  extension-registered tools) on the right. Line 2 (when populated) shows
  the recipe's `skills:` list on the left and the recipes this agent may
  spawn via `mesh_spawn` on the right — both as plain comma-separated
  lists, no labels, matching line 1's bare style. Reads both from
  `getHabitat()`; the line is skipped entirely when both lists are empty.
  Line 3 shows
  `$cost` and the context-usage percent on the left, model id on the
  right — pi's default token-flow stats (↑input, ↓output, cache R/W,
  context window size) are intentionally dropped. Line 4 is the
  extension-status line. Ships in `@agentfactory/ui-rails`.
- `hide-extensions-list` — strips pi's `[Extensions]` section (added by
  `showLoadedResources` to the chat history at startup) since the
  agent-footer already shows the active tools and the path listing is
  noise. Reaches into private TUI state via `setWidget`+`setTimeout(0)`
  because pi has no public API to suppress per-section. Ships in
  `@agentfactory/ui-rails`.
- `deferred-confirm` — end-of-turn coordinator for any `deferred-*`
  extension. Exposes `registerDeferredHandler({ label, extension,
  priority, prepare })` (named export) plus a single `agent_end` listener
  that calls every registered handler's `prepare(ctx)`, aggregates the
  results into one approval prompt (sections grouped by handler label,
  summary line in the title), and on approval invokes each handler's
  `apply()` in priority order (10 writes → 20 edits → 25 moves → 30
  deletes). Any handler returning `status: "error"` aborts the entire
  batch before the prompt renders. The handler array is stashed on
  `globalThis` so it survives jiti's per-extension module isolation
  (`loader.js` uses `moduleCache: false`). No-op for agents that don't
  load any deferred-* extension — when no handlers register,
  `agent_end` returns silently.

  **Approval routing** is handled by an exported helper in
  `_lib/escalation.ts`,
  `requestHumanApproval(ctx, pi, {title, summary, preview}) →
  Promise<boolean>`. After Phase 5 the routing is:
  - `ctx.hasUI` → renders `ctx.ui.confirm` locally (this terminal is
    the human's).
  - else loud-fails to stderr (`[deferred] dropped: no UI available`)
    and returns `false`.

  Cross-agent escalation now flows over the bus as a typed
  `approval-request` envelope handled by the supervisor rail (see the
  Supervisor inbound rail section below) rather than over per-call
  Unix sockets.

  When no UI is present, the apply-loop's status notifications
  (`writes applied: …`, `edits applied: …`, etc.) are routed to
  stdout as `[deferred] …` lines so any wrapping process that
  captures the worker's stdout still sees them.

```sh
set -a; source models.env; set +a
pi --recipe deferred-writer                          # interactive, sandboxed to $PWD
pi --recipe deferred-writer --sandbox /tmp/scratch
pi --recipe deferred-writer -p "draft a README" --thinking off
```

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
spawns: [deferred-writer]         # optional; recipes this agent may spawn via mesh_spawn
```

> **Peer wiring is topology-only.** Recipes no longer accept `supervisor`, `submitTo`, `acceptedFrom`, or `peers` — the engine rejects them at parse time. All peer relationships are declared in the topology YAML and reach the agent's Habitat via `--topology-overlay` at launch. See "Topology YAML" below.

When the resolved Habitat (from the topology overlay) sets `submitTo`, the `deferred-*` end-of-turn flow ships the aggregated artifacts to that peer as a `submission` bus envelope instead of rendering a local approval dialog. The worker waits for an `approval-result` reply: on approval it logs `"submission applied by supervisor"` (the supervisor handles the actual writes); on rejection it discards the queue and logs the reason. Agents whose Habitat does not set `submitTo` keep the local UI-or-fail approval flow unchanged.

### `prompt:` and extension fragments

Tool-usage rules live next to the extensions that register the tools, not
in each recipe's `prompt:`. For each loaded extension `<name>`, the engine
looks for a sibling `<name>.prompt.md` in the extension's owning package
and, if present, prepends it to the system prompt that pi receives.
Recipes only need to describe the agent's role; the standard rules for
`deferred_write`, `deferred_edit`, `mesh_spawn`, etc. come from the
fragments.

One conditional fragment is gated by the engine so it doesn't appear
when irrelevant:

- `deferred-confirm.prompt.md` (apply order, atomic batch semantics) is
  loaded only when at least one `deferred-*` tool extension is active —
  baseline `deferred-confirm` itself is a no-op without one.

Final order seen by the model: engine-extension fragments → recipe-
extension fragments → recipe `prompt:`. Edit a fragment to change behaviour
for every recipe that loads its extension; edit a recipe's `prompt:`
for that one agent only.

The engine registers six launch flags that `mesh-mux` and `mesh-spawn`
pass when spawning `pi --recipe` children: `--sandbox`, `--task`,
`--peer-name`, `--topology-overlay`, `--inherit-pty`, and `--debug`.
All six appear under "Extension CLI Flags" in `pi --help`.

### Missing rail cluster — hard error

If a recipe lists an extension whose owning cluster package is not
installed, the engine refuses to start the session with a clear message:

```
recipe-loader: missing rail cluster(s):
  rail 'deferred-write' requires cluster 'deferred-rails' — install with: pi install npm:@agentfactory/deferred-rails
```

Install the named cluster and retry. Never silently skip a missing rail
(skipping `sandbox` would disable FS containment without warning).

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

## Packaging — engine and cluster packages

`@agentfactory/pi-engine` is the always-on package: it ships the
`recipe-loader` extension (which registers `--recipe` and the six launch
flags) plus the full mesh subsystem (`agent-bus`, `supervisor`,
`intercept`, `launcher-bridge`, `slash-commands`, `bus-tail-emitter`,
`mesh-rail`, `mesh-authority`). It loads on every `pi` invocation but is
**loaded-but-inert** — with no `--recipe` flag, raw `pi` behaves like
vanilla pi.

Three independently-installable **cluster packages** ship the generic rails:

| Package | Rails included |
| --- | --- |
| `@agentfactory/deferred-rails` | `deferred-confirm`, `deferred-write`, `deferred-edit`, `deferred-move`, `deferred-delete` |
| `@agentfactory/containment-rails` | `sandbox`, `no-edit` |
| `@agentfactory/ui-rails` | `agent-header`, `agent-footer`, `no-startup-help`, `hide-extensions-list` |

Each cluster depends only on `@agentfactory/pi-engine` — a star topology
with no inter-cluster edges. A recipe that references a rail from an
uninstalled cluster hard-errors with a `pi install npm:@agentfactory/<cluster>`
hint.

## Worked example: deferred-writer

`pi-sandbox/agents/deferred-writer.yaml` composes three extensions:

- `sandbox` (baseline) — disables `bash`, clamps fs activity to the root.
- `deferred-write` — registers the `deferred_write` tool. Drafts are
  buffered in extension memory; the extension registers a handler with
  the `deferred-confirm` baseline that previews queued drafts and writes
  approved ones (sha256-verified after write, ≤ 50 files / ≤ 2 MB each).
- `no-edit` — blocks `edit` outright and rejects any create-only tool
  whose target already exists. The create-only set is discovered at
  session start from `pi.getAllTools()`: any tool whose schema declares
  `path: string` plus a content-shaped string field
  (`content` | `text` | `body`). The static fallback covers `write` and
  `deferred_write`. Drop the extension entirely if you want an agent
  that can overwrite or edit existing files, or compose a custom
  extension if you need a different create-only tool set.

Non-interactive runs refuse to write because there's no UI to confirm.

`deferred-write` and `no-edit` are independent rails: an agent that wants
overwrite-on-approval keeps `deferred-write` and omits `no-edit`; an
agent using plain `write` but still wanting create-only semantics keeps
`no-edit` and omits `deferred-write`.

## Worked example: deferred-author (composing all four kinds)

`pi-sandbox/agents/deferred-author.yaml` composes the full set of
deferred-* tool extensions and relies on `deferred-confirm` (baseline)
to show one approval dialog at end-of-turn:

- `deferred-write` — `deferred_write({path, content})`. Creates new
  files. Same shape and limits as the worked example above.
- `deferred-edit` — `deferred_edit({path, old_string, new_string})`.
  Modifies existing files. Validates `old_string` is unique against the
  buffered file state at queue time, so multi-edit ordering works. Re-
  validates against disk at apply time; any drift aborts the batch.
- `deferred-move` — `deferred_move({src, dst})`. Verbatim relocation:
  bit-identical content at the new path. Refuses to overwrite (`dst`
  must not exist). Parent directories of `dst` are auto-created at
  apply time. Cross-device EXDEV falls back to copy + unlink.
- `deferred-delete` — `deferred_delete({path})`. Removes existing files
  (rejects directories and missing paths at queue time so the model
  gets immediate feedback).

End-of-turn approval is **all-or-nothing across all four kinds**: the
`deferred-confirm` coordinator collects every handler's `prepare`
result, aborts the whole batch if any returns `status: "error"`,
otherwise renders one `ctx.ui.confirm` with sections per handler. On
approve, the apply phase runs in fixed priority order (writes → edits
→ moves → deletes) so compositions like "edit `foo.ts`, then move it
to `lib/foo.ts`" land deterministically — the edit hits the original
path, then the rename moves the now-edited file. The reverse ("move
then edit at the new path") fails at the edit's re-validation because
`dst` doesn't exist when the edit's `prepare` reads from disk.

Authoring agents should compose the four deferred-* extensions and let
`deferred-confirm` drive the dialog rather than each running its own.
`no-edit` is redundant under this composition: the recipe's `tools:`
allowlist already omits the built-in `edit`/`write`, and each
deferred-* tool enforces its own existence/non-existence preconditions
at queue time.

## Worked example: writer-foreman (mesh_spawn)

`pi-sandbox/agents/writer-foreman.yaml` is a Lead-tier foreman that
decomposes a drafting request and dispatches focused batches to
`deferred-writer` workers. The recipe declares:

```yaml
spawns: [deferred-writer]
tools: [read, ls, grep, find, mesh_spawn, mesh_kill, peer_send, peer_call, peer_inbox, respond_to_request]
```

Flow per task:

1. Foreman calls `mesh_spawn({recipe: "deferred-writer", task: "…"})`.
   The call spawns a long-lived worker with the given task and returns
   immediately with the worker's name.
2. `mesh-spawn` allocates a fresh tmpdir scratch root, constructs a
   habitat overlay (`supervisor = submitTo = acceptedFrom = [foreman]`),
   and spawns the worker via `pi --recipe deferred-writer` (using
   `buildRecipeChildArgv` from `packages/engine/agent/lib/child-spawn.mjs`).
   The worker's name is registered in the `__pi_mesh_spawn_nodes__` registry.
3. The worker runs, drafts files into its in-memory `deferred-write`
   queue, hits `agent_end`. Because `submitTo` is set, `deferred-confirm`
   ships a `submission` envelope to the foreman over the bus and waits
   for a reply.
4. The foreman's supervisor rail receives the submission. The
   `__pi_mesh_spawn_is_my_worker__` predicate (set by `mesh-spawn`) admits
   the worker's envelope before the static `acceptedFrom` check, so
   dynamically-spawned names don't need to be pre-listed.
5. The supervisor rail queues the submission and prompts the foreman's
   model. Multiple submissions arriving in the same turn are batched
   into one composite prompt (N-of-M style), so the foreman reviews all
   pending work together in one `respond_to_request` call per item.
6. The foreman calls `respond_to_request` to approve, reject, or revise.
   On approval, artifacts are applied to the canonical filesystem and the
   worker receives `approval-result(approved:true)` — the worker exits
   cleanly. The foreman can then call `mesh_kill` to clean up.

A foreman that is itself a worker in a larger mesh submits its own
artifacts to its supervisor; the recursive shape works at every tier.

### Debugging the rails

Pass `--debug` when launching an agent and the `sandbox` and `no-edit`
extensions will dump their resolved tool sets via `ctx.ui.notify` on
`session_start`. Useful when you've added a new write tool and want to
confirm it was picked up by introspection.

The rails — `agent-header`, `agent-footer`, and `deferred-confirm`'s
end-of-turn `ctx.ui.confirm` dialog — only render under a real PTY,
so `pi -p` print mode can't exercise them. For integration testing,
drive a full TUI session under tmux:

```sh
set -a; source models.env; set +a
tmux new-session -d -s pi-test -x 200 -y 50 \
  'pi --recipe deferred-writer --debug'
sleep 5                                              # let pi boot + print debug
tmux send-keys -t pi-test 'draft hello.txt saying hi' Enter
sleep 30                                             # wait for the model
tmux capture-pane -t pi-test -p                       # snapshot the screen
tmux send-keys -t pi-test 'y' Enter                   # approve deferred_write dialog
sleep 5
tmux capture-pane -t pi-test -p
tmux send-keys -t pi-test '/quit' Enter
```

Caveats: this hits the real model so each run costs a fraction of a
cent, and `capture-pane -p` returns plain text — colors and bold from
`agent-header` won't show up in the snapshot.

### Unit tests (`npm test`)

Unit tests live alongside source files as `*.test.ts` and run via
`npm test` (vitest). They are **hermetic by contract**: no model API
calls, no network, no env vars from `models.env`, no real filesystem
outside the test's tmpdir. Tests that need a live model belong in the
tmux integration pattern above, not in `npm test`. Run `npm run
test:watch` for a red-green-refactor loop while iterating on a pure
library module.

Unit tests run automatically in CI on every push and PR; tmux integration tests stay local.

## Mandatory safety rails for sub-agents

When an extension delegates to a child `pi` process:

- Pass `--no-extensions` to the child — prevents recursive sub-agents.
- Whitelist the child's tools (`--tools read,grep,...`) to match its role.
- Forward the parent's `AbortSignal` and truncate captured stdout (~20 KB).
- Match the tier to the child's role: `$TASK_RABBIT_MODEL` for workers,
  `$LEAD_HARE_MODEL` for reviewers, `$RABBIT_SAGE_MODEL` for orchestration.

See `pi-sandbox/skills/pi-agent-builder/references/` for recipe-level detail.

## Multi-agent: spawn vs. talk

Two orthogonal extensions cover the two distinct relationships a recipe
might want with another agent. `mesh-spawn` is opt-in via `extensions:` +
`tools:` (or via `spawns:` in the recipe, which auto-adds it);
`peer-bus` is also opt-in via `extensions:` + `tools:`. A recipe can use
either, both, or neither.

### `mesh-spawn` — long-lived worker spawn over the bus

Wired when the recipe includes `mesh-spawn` in `extensions:` (or declares
`spawns: [a, b, …]`). Registers two tools:

- `mesh_spawn({recipe, task, groups?, sandbox?})` — spawns
  `pi --recipe <recipe>` in a fresh tmpdir scratch root via
  `buildRecipeChildArgv` (in `packages/engine/agent/lib/child-spawn.mjs`),
  starts the worker with the given task, and returns immediately with the
  worker's name. The worker is long-lived — it persists until killed.
- `mesh_kill({name})` — sends a `shutdown` envelope to the named worker
  and removes it from the registry.

**Worker habitat overlay.** Each spawned worker is locked to the
caller via a `--topology-overlay` JSON blob set by the extension:

```json
{
  "supervisor": "<callerName>",
  "submitTo": "<callerName>",
  "acceptedFrom": ["<callerName>"],
  "peers": ["<callerName>"]
}
```

So the worker can only message the caller, can only submit to the
caller, and won't accept typed inbound envelopes from anyone else.
The overlay overrides whatever peer fields the worker recipe declares.

**Admission.** When the worker ships a submission to the caller's bus
socket, `peer-bus.handleIncoming` checks the `__pi_mesh_spawn_is_my_worker__`
predicate (set by `mesh-spawn` at init). If the worker name is in the
registry, the envelope is admitted even if it isn't in the static
`acceptedFrom` list — so dynamically-spawned names don't need to be
pre-listed in the topology.

**Pre-flight checks** in `mesh_spawn.execute`:

1. **Recipe allowlist** — `params.recipe` must be in
   `getHabitat().spawns`. Error: `recipe_not_allowed`.
2. **Recipe exists** — `pi-sandbox/agents/<recipe>.yaml` must exist.
   Error: `recipe_not_found`.
3. **Groups validation** — group names must not start with `_`.
   Error: `reserved_group_name`.

**Cleanup.** `session_shutdown` cascade-kills all registered nodes.
`mesh_kill` kills a specific worker on demand.

Worked examples: `pi-sandbox/agents/writer-foreman.yaml` (single-
recipe foreman driving `deferred-writer`) and
`pi-sandbox/agents/delegator.yaml` (general-purpose planner with a
broad allowlist).

### `peer-bus` — async peer messaging (long-lived, named)

Registers four tools and one CLI flag:

- `peer_send({to, body, in_reply_to?})` — fire-and-forget. Connects to
  `${BUS_ROOT}/${to}.sock`, writes one JSON envelope, returns
  `{msg_id, delivered}`. `peer offline` / `timeout` are normal failure
  modes (no retry, no offline queue).
- `peer_inbox({since_ts?, peek?})` — pull buffered envelopes. By
  default returned messages are cleared from the inbox; `peek=true`
  keeps them.
- `peer_list()` — probe `${BUS_ROOT}/*.sock` for live peers; clean up
  stale socks left by crashed peers.
- `peer_call({to, body, timeout_ms?})` — request/response call to a
  peer. Blocks until a reply arrives or the timeout expires.
- `--agent-bus-root <dir>` — the rendezvous directory. Resolution
  order: this flag → `~/.pi-agent-bus/<basename of sandbox-root>`.
  The runner sets the flag automatically and accepts
  `--agent-bus <dir>` (parallel to `--sandbox <dir>`) to override.

Each agent listens on `${BUS_ROOT}/${name}.sock` (name comes from
`--peer-name`, which the engine sets to a generated
`<breed>-<shortName>` slug — unique per instance — unless the
`--peer-name <override>` wins). The engine probes the
bus root before generating so two roots launched in different terminals
won't collide; explicit overrides are needed when peers want to address
each other by a stable role name (e.g. `planner`, `worker-a`). Incoming
messages buffer in an in-memory inbox and, between turns, are pushed
into the agent's next turn via `pi.sendUserMessage("[from <peer>]
<body>")`. Mid-turn arrivals are held in a `pendingDuringTurn` queue
and drained at `turn_end` so the live LLM call is never interrupted.

The bus root deliberately lives **outside** `--sandbox-root` so the
`sandbox` extension's path-rejection doesn't trip on socket paths. The
bus extension never invokes path-bearing built-in tools, so the sandbox
allowlist is unaffected.

Stale-sock handling: on bind, `EADDRINUSE` triggers a probe-connect; if
the previous owner refuses, the sock is unlinked and bind retried once.
A live peer at the same name fails loudly. On send, `ECONNREFUSED` /
`ENOENT` opportunistically unlinks the dead sock and returns
`{delivered:false, reason:"peer offline"}`.

v1 defaults intentionally deferred to later: no auth (filesystem perms
only), no offline queue, no synthesised request/response correlation
beyond the optional `in_reply_to` field, hard-fail on name collision.

Worked example: `pi-sandbox/agents/peer-chatter.yaml`.

### Why two systems and not one

`mesh_spawn` is a fire-and-supervise pattern: the caller spawns a long-lived
worker, the worker submits work over the bus, and the caller reviews it via
`respond_to_request`; peer-talk is async long-lived messaging
(stable named peers, `pi.sendUserMessage` delivery). Both ride the same
Unix-socket bus protocol — `mesh_spawn` workers use the same `submission`
envelope kind that the supervisor inbound rail handles — but the
recipe-level affordances differ enough that keeping them as two independent
extensions lets recipes mix exactly the relationship they need.

### Verifying the multi-agent rails

The preferred way to run and observe a live multi-agent mesh is via
`npm run mesh -- <recipe-name>`. The host recipe launches with `--is-host`,
activating `mesh-mux`, which pre-spawns all `initial_mesh:` peers and
multiplexes their PTY sessions. The focused peer's PTY is rendered live in
the main pane, with a single-line mesh-status widget (peer name, peer count,
decisions count) pinned directly above the input editor by the auto-loaded
`mesh-rail` baseline extension. Bus-tail output and the decisions queue
surface via slash commands (`/tail`, `/decisions`). The human is not a peer;
the host TUI is the sole human interface.

```sh
set -a; source models.env; set +a
# Launch the authority-mesh host recipe (pre-spawns analyst + writer):
npm run mesh -- authority-mesh
# The launcher opens with the first spawned peer focused.
# Use /focus <name>  to switch to another peer's pane.
# Use /tail          to stream the inter-peer bus traffic.
# Type a message in any peer pane; it lands in that peer's pi session.
```

The launcher wire format is documented in
`packages/engine/agent/lib/launcher-envelope.mjs` — consult that file when
writing extensions that emit control envelopes (focus-request, pin-request,
decisions-jump, tail-event, etc.).

To exercise the **mesh_spawn** flow end-to-end, drive
`writer-foreman` (single file):

```sh
set -a; source models.env; set +a
mkdir -p /tmp/foreman-test
tmux new-session -d -s foreman -x 200 -y 50 \
  'pi --recipe writer-foreman --sandbox /tmp/foreman-test --debug'
sleep 5
tmux send-keys -t foreman \
  'draft hello.txt with text "Hi"' Enter
sleep 60                              # foreman spawns worker; worker drafts and
                                      # ships submission; foreman reviews via
                                      # respond_to_request and approves.
tmux capture-pane -t foreman -p       # expect submission review prompt.
tmux send-keys -t foreman '/quit' Enter
```

For **multiple workers submitting in one turn** (batched into one composite
supervisor prompt):

```sh
tmux send-keys -t foreman \
  'draft two files: hello.txt saying "Hi" and world.txt saying "World"' Enter
sleep 120   # foreman spawns two workers; both submissions arrive;
            # one composite supervisor prompt shows both items.
```

Negative cases worth probing manually:

- **Loud fail under print mode**: run `pi --recipe deferred-writer
  -p "draft x.txt"` directly. With no UI, the worker exits but stderr
  contains `[deferred] dropped: no UI available`. (Cross-agent
  approval forwarding flows over the bus via the supervisor rail.)
- **Recipe not allowed**: prompt foreman with `mesh_spawn` for an
  unlisted recipe → `recipe_not_allowed` error.
- **Missing cluster**: a recipe listing `extensions: [deferred-write]`
  when `@agentfactory/deferred-rails` is not installed → engine errors
  with a `pi install npm:@agentfactory/deferred-rails` hint.

## Supervisor inbound rail

The **supervisor** extension (`packages/engine/agent/extensions/supervisor.ts`) implements
the inbound review loop described in [ADR-0003](../docs/adr/0003-supervisor-llm-in-review-loop.md).
The extension registers the `respond_to_request` tool and a globalThis dispatch hook
that `peer-bus` calls when a typed non-message envelope arrives.

### Automatic wiring

`supervisor`, `intercept`, and `respond_to_request` are **baseline** — loaded for
every agent by default. Both extensions self-gate via `getHabitat().acceptedFrom`:
when the topology overlay sets no inbound peers, the supervisor and intercept rails
are silent no-ops and the `respond_to_request` tool returns a "no pending request"
message rather than crashing.

### Inbound envelope kinds handled

| Kind | Source | Rail action |
|------|--------|-------------|
| `approval-request` | peer in `acceptedFrom` | Queued; model prompted |
| `submission` | peer in `acceptedFrom` | Queued; model prompted |
| Either kind from unknown peer | anyone not in `acceptedFrom` | Dropped silently (stderr when `--debug`) |
| `message` | any peer | Free-flow (unrestricted, existing behaviour) |

### Four-action flow via `respond_to_request`

When the model receives an inbound prompt it uses:

```
respond_to_request({msg_id, action, note?})
```

| Action | Effect |
|--------|--------|
| `approve` on `approval-request` | Sends `approval-result(approved:true)` to original sender; closes thread |
| `approve` on `submission` | Applies artifacts to canonical filesystem (`getHabitat().scratchRoot`), then sends `approval-result(approved:true)` on success or `approval-result(approved:false, note:"apply failed: …")` on SHA-mismatch or apply error; closes thread either way |
| `reject` | Sends `approval-result(approved:false)` to original sender; closes thread. Does **not** touch the filesystem. |
| `revise` | Sends `revision-requested(note)` to original sender; thread stays open (note **required**). Does **not** touch the filesystem. |
| `escalate` | Forwards to `getHabitat().supervisor` via bus; relays result back to sender; closes thread |

**Submission apply semantics (Phase 4b):** `approve` on a `submission` envelope runs a two-pass verify-then-apply:

1. **Verify pass** — all artifact SHAs are checked against the current canonical filesystem without touching any files. A SHA mismatch on any artifact in the batch aborts the entire batch (atomic).
   - `write`: no SHA verification (content is new; the SHA field is informational).
   - `edit`: current file content must hash to `sha256OfOriginal`.
   - `move`: source file must hash to `sha256OfSource`; destination must not exist.
   - `delete`: current file content must hash to `sha256`.
2. **Apply pass** — artifacts are applied in fixed priority order (writes → edits → moves → deletes), regardless of the order they appear in the envelope. This matches `deferred-confirm`'s priority order so compositions like "edit X then move it to Y" work deterministically.

Revision cycles are **capped at 3 per thread** (keyed by the root `msg_id`). After
the cap, only `approve` or `reject` are accepted; a further `revise` returns an
error without sending anything.

**Composite submission batching (Slice 6):** When N submissions arrive during the
same supervisor turn (e.g. two `mesh_spawn` workers both submit before the foreman
finishes its current turn), `supervisor-inbox` batches them. At `turn_end` a single
composite prompt is assembled — `N=1` uses the existing single-section format;
`N>1` produces a numbered composite with one section per submission. The foreman
reviews each item with a separate `respond_to_request({msg_id, action})` call. This
avoids N separate prompt interruptions when multiple workers submit concurrently.

The model-facing prompt fragment (`supervisor.prompt.md`) is loaded automatically
when the supervisor extension is active; it contains action descriptions and usage
examples.

### Testable core

The action routing, acceptedFrom enforcement, and revision cap all live in
`packages/engine/agent/lib/supervisor-inbox.ts` with a matching
`supervisor-inbox.test.ts`. The `supervisor.ts` extension is a thin pi
wrapper; tests can exercise the full action graph without a live model.

### Escalation and the escalation primitive

`requestHumanApproval` lives in the engine's `_lib/escalation.ts` and is
imported by `deferred-confirm.ts`. It routes only `ctx.hasUI` →
`ctx.ui.confirm` or loud-fails to stderr; cross-agent escalation flows
over the bus as an `approval-request` envelope handled by the supervisor
rail (the `escalate` action sends to `getHabitat().supervisor` directly,
no rpc-sock fallback).

## Host Recipes (Mesh Launch Pattern)

> **Note:** The topology YAML / `scripts/launch-mesh.mjs` pattern is superseded
> by host recipes (Slice 5). This section is a short stub pointing at the new
> pattern; a full rewrite is deferred to Slice 8.

Meshes are now described as **host recipes**: a single YAML in `pi-sandbox/agents/`
that declares `spawns:` (child recipe allowlist) and `initial_mesh:` (peers to
pre-spawn at session start). The host is launched with `--is-host`, which activates
the `mesh-mux` extension. `mesh-mux` pre-spawns all `initial_mesh:` entries, binds
the launcher socket, and multiplexes their PTY sessions into the host's terminal.

```sh
set -a; source models.env; set +a
npm run mesh -- grouped-mesh   # launches pi-sandbox/agents/grouped-mesh.yaml with --is-host
```

Example host recipes in `pi-sandbox/agents/`:
- `mesh-host-example.yaml` — minimal two-peer example (Slice 4 reference)
- `anon-grouped-mesh.yaml` — host + anonymous worker in group "workers"
- `authority-mesh.yaml` — host + two anonymous workers (analyst + writer)
- `grouped-mesh.yaml` — host + named analyst/writer/reviewer with cross-group wiring

Per-entry wiring fields in `initial_mesh:` (`escalatesTo`, `submitsWorkTo`,
`acceptsWorkFrom`, `messagesWith`) override the default host-wiring for that peer.
`@<group>` refs in those fields expand against the pre-allocated peer-group index.

See `pi-sandbox/agents/mesh-host-example.yaml` for the canonical shape.
A full documentation refresh (Slice 8) will replace this stub.
