# Composing agents — `npm run agent`

Day-to-day, the way to launch a focused agent is `npm run agent -- <name>`.
The runner (`scripts/run-agent.mjs`) reads a YAML recipe from
`pi-sandbox/agents/<name>.yaml`, resolves the model tier, and execs `pi`
from the directory you invoked it from (or `--sandbox <dir>`). Every
agent gets six baseline extensions:

## Per-instance names

Every agent instance — user-launched root or delegated child — is named
`<breed>-<shortName>`. The breed is a randomly-picked rabbit (or a hare
if `model:` is `LEAD_HARE_MODEL`); the short name comes from the
recipe's optional `shortName:` field, falling back to the recipe
filename stem. The slug is filesystem-safe and doubles as the
`agent-bus` socket identity; the header prettifies it for display (so
`cottontail-writer` renders as "Cottontail Writer"). Breed pools live
in [`scripts/breed-names.json`](../scripts/breed-names.json) and the
generator + collision detection in
[`scripts/agent-naming.mjs`](../scripts/agent-naming.mjs).

Collision detection runs in two places: `atomic-delegate` tracks
in-flight sibling slugs in its pending-workers map so two parallel
`deferred-writer` children always get different breeds; the runner
probes `${BUS_ROOT}/*.sock` so a second `peer-chatter` launched in
another terminal won't pick a breed that's already bound. `--agent-name
<override>` in passthrough still wins for both — useful when you want a
stable peer name on the bus.

- `sandbox` — blocks `bash` outright and rejects any path-bearing tool
  call whose `path` resolves outside the sandbox root. The set of
  path-bearing tools is discovered at session start from
  `pi.getAllTools()` (any tool whose schema declares `path: string`),
  with a static fallback of `{read, write, edit, ls, grep, find}` for
  the installed pi 0.70 built-ins. Owns the `--sandbox-root <path>`
  flag (read by `agent-footer`, `deferred-write`, and `no-edit` via
  `pi.getFlag`); falls back to `ctx.cwd` when the flag is unset.
- `no-startup-help` — suppresses pi's default startup header (logo,
  keybinding cheatsheet, onboarding tips) since most of those keybindings
  reference features focused agents don't use.
- `agent-header` — replaces the (now-empty) header with a banner that
  shows the agent's full display name (bold accent) — the breed from
  the `<breed>-<shortName>` slug joined with the prettified recipe
  filename, e.g. `Cottontail Deferred Writer` — optionally suffixed
  dim with the model tier (e.g. `· Task Rabbit`), and the recipe's
  `description:` field on the next line (dim). Reads `--agent-name`,
  `--agent-description`, `--agent-tier`, and `--agent-type`; the
  runner sets them from the generated `<breed>-<shortName>` slug,
  `description:`, `model:` (tier suffix skipped for literal model
  IDs), and the recipe filename respectively. Slug segments are
  rendered via the shared `prettify` helper in
  `pi-sandbox/.pi/extensions/_lib/agent-naming.ts` (title-case each
  hyphen-segment, join with spaces). Each flag can be passed on the
  `npm run agent --` line to override the recipe (passthrough flags
  come after recipe-derived ones, so the CLI value wins).
- `agent-footer` — replaces pi's default footer. Line 1 shows the
  sandbox root on the left and the comma-separated active tools (from
  `pi.getActiveTools()`, i.e. the recipe's `tools:` allowlist plus any
  extension-registered tools) on the right. `delegate` is filtered out
  of the tool list because every delegating agent has it — it tells
  the user nothing about what the recipe can actually do, and the
  agents-it-can-spawn list on line 2 already conveys delegation
  capability. Line 2 (when populated) shows the recipe's `skills:`
  list on the left and the recipes this agent may `delegate` to on
  the right — both as plain comma-separated lists, no labels,
  matching line 1's bare style. Reads both from `getHabitat()`; the
  line is skipped entirely when both lists are empty. Line 3 shows
  `$cost` and the context-usage percent on the left, model id on the
  right — pi's default token-flow stats (↑input, ↓output, cache R/W,
  context window size) are intentionally dropped. Line 4 is the
  extension-status line.
- `hide-extensions-list` — strips pi's `[Extensions]` section (added by
  `showLoadedResources` to the chat history at startup) since the
  agent-footer already shows the active tools and the path listing is
  noise. Reaches into private TUI state via `setWidget`+`setTimeout(0)`
  because pi has no public API to suppress per-section.
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
npm run agent -- deferred-writer            # interactive, sandboxed to $PWD
npm run agent -- deferred-writer --sandbox /tmp/scratch
npm run agent -- deferred-writer -p "draft a README" --thinking off   # passthrough
```

## Recipe shape

```yaml
# pi-sandbox/agents/<name>.yaml
model: TASK_RABBIT_MODEL          # tier name from models.env, or a literal model ID
shortName: writer                 # optional; used in the generated <breed>-<shortName> instance slug. Falls back to the filename stem.
description: Drafts files...      # optional; shown by agent-header in the TUI
prompt: |                         # the agent's role, prepended with extension fragments
  You are a careful drafter...
tools: [read, ls, grep, deferred_write]
extensions: [deferred-write]      # merged with the [sandbox, no-startup-help, agent-header, agent-footer, hide-extensions-list, deferred-confirm] baseline
skills: [pi-agent-builder]        # optional; resolved against pi-sandbox/skills/
provider: openrouter              # optional; defaults to openrouter
noEditAdd: [my_writer]            # optional; force-include in no-edit rail
noEditSkip: [deferred_write]      # optional; exempt from no-edit rail
agents: [deferred-writer]         # optional; recipes this agent may delegate to
supervisor: lead-hare             # optional; peer name to escalate approvals to
submitTo: collector               # optional; peer name to ship submissions to
acceptedFrom: [worker-a, worker-b] # optional; peers allowed to send to this one
peers: [planner, reviewer]        # optional; peers this one may address
```

> **Phase 3b note:** `supervisor`, `acceptedFrom`, and `peers` are declarable and materialised into the `Habitat` but no rail enforces them yet. `acceptedFrom` becomes active in Phase 3c when the supervisor inbound rail and peer allowlist are wired.

When `submitTo` is set on a recipe, the `deferred-*` end-of-turn flow ships the aggregated artifacts to that peer as a `submission` bus envelope instead of rendering a local approval dialog. The worker waits for an `approval-result` reply: on approval it logs `"submission applied by supervisor"` (the supervisor handles the actual writes); on rejection it discards the queue and logs the reason. A `revision-requested` reply is treated as rejection in Phase 4a — revision threading lands in Phase 4c. Recipes that do **not** set `submitTo` keep the local UI-or-fail approval flow unchanged.

### `prompt:` and extension fragments

Tool-usage rules live next to the extensions that register the tools, not
in each recipe's `prompt:`. For each loaded extension `<name>`, the runner
looks for a sibling `pi-sandbox/.pi/extensions/<name>.prompt.md` and, if
present, prepends it to the system prompt that pi receives. Recipes only
need to describe the agent's role; the standard rules for `deferred_write`,
`deferred_edit`, `delegate`, etc. come from the fragments.

One conditional fragment is gated by the runner so it doesn't appear
when irrelevant:

- `deferred-confirm.prompt.md` (apply order, atomic batch semantics) is
  loaded only when at least one `deferred-*` tool extension is active —
  baseline `deferred-confirm` itself is a no-op without one.

Final order seen by the model: baseline-extension fragments → recipe-
extension fragments (including `atomic-delegate.prompt.md` when implicit
from `agents:`) → recipe `prompt:`. Edit a fragment to change behaviour
for every recipe that loads its extension; edit a recipe's `prompt:`
for that one agent only.

The runner always passes `--no-extensions --no-skills --no-context-files`
to pi, so only what the recipe declares is loaded. Tool names go through
pi's `--tools` allowlist (built-in + extension-registered tools both
qualify). Recipe-derived values reach the extensions as registered CLI
flags: `--sandbox-root <path>` (always set), `--agent-name <name>`
(always set), `--agent-description <text>` (when `description:` is set),
`--agent-tier <TIER_VAR>` (when `model:` is a tier var name),
`--no-edit-add` / `--no-edit-skip` (when the matching list is
non-empty), and `--allowed-agents <a,b,c>` (when `agents:` is set).
All seven appear under "Extension CLI Flags" in `pi --help`.

When `agents:` is non-empty the runner also implicitly:

- adds `atomic-delegate` to `extensions:`, and
- adds `delegate` to `tools:`.

Explicit duplicates in the recipe are fine. The inverse is rejected
loudly: declaring `extensions: [atomic-delegate]` or `tools: [delegate]`
without `agents:` causes the runner to `die()` so the allowlist is
never accidentally empty. To disable delegation, drop the `agents:`
field entirely.

> **Live status widget:** the per-delegation status boxes that
> previously rendered above the input editor (the
> `delegation-boxes` widget fed by `agent-status-reporter` over
> `--rpc-sock`) are deferred to a later phase. After Phase 5 the
> model gets a textual summary as the `delegate` tool's return
> value; there is no live progress indicator while the worker is
> running.

## Where agent code lives

| Location | Behavior |
| --- | --- |
| `pi-sandbox/agents/<name>.yaml` | Agent recipe consumed by `npm run agent` |
| `pi-sandbox/.pi/extensions/<name>.ts` | Project-local extension, auto-discovered by `npm run pi`; loaded explicitly by `npm run agent` when listed in a recipe |
| `~/.pi/agent/extensions/<name>.ts` | Global extension, hot-reloadable via `/reload` |
| `pi -e ./path.ts` | One-off test load (not hot-reloadable) |

## Worked example: deferred-writer

`pi-sandbox/agents/deferred/deferred-writer.yaml` composes three extensions:

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
  `deferred_write`. Override per recipe with `noEditAdd` (force-include)
  or `noEditSkip` (force-exclude). Drop the extension entirely if you
  want an agent that can overwrite or edit existing files.

Non-interactive runs refuse to write because there's no UI to confirm.

`deferred-write` and `no-edit` are independent rails: an agent that wants
overwrite-on-approval keeps `deferred-write` and omits `no-edit`; an
agent using plain `write` but still wanting create-only semantics keeps
`no-edit` and omits `deferred-write`.

## Worked example: deferred-author (composing all four kinds)

`pi-sandbox/agents/deferred/deferred-author.yaml` composes the full set of
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

## Worked example: writer-foreman (atomic delegate)

`pi-sandbox/agents/deferred/writer-foreman.yaml` is a Lead-tier foreman that
decomposes a drafting request and dispatches focused batches to a
`deferred-writer` child. The recipe declares only:

```yaml
agents: [deferred-writer]
tools: [read, ls, grep, find]
```

The runner implicitly loads `atomic-delegate` and adds `delegate` to
the tool allowlist; the spawned worker is locked to recipes in
`deferred-writer`'s allowlist.

Flow per batch:

1. Foreman calls `delegate({recipe: "deferred-writer", task: "…"})`.
   The call is a single atomic round-trip.
2. The atomic-delegate extension allocates a fresh tmpdir scratch root,
   constructs a habitat overlay (`supervisor = submitTo = peers =
   acceptedFrom = [foreman]`, `agents = []`), spawns the worker via
   `node scripts/run-agent.mjs`, and registers a per-worker dispatch
   hook on the bus.
3. The worker runs `pi -p`, drafts files into its in-memory
   `deferred-write` queue, hits `agent_end`. Because `submitTo` is set,
   `deferred-confirm` ships a `submission` envelope to the foreman over
   the bus and waits for a reply.
4. Foreman's `agent-bus.handleIncoming` calls the
   `__pi_atomic_delegate_dispatch__` hook (which runs BEFORE the
   `acceptedFrom` check). The hook:
   - Sends `approval-result(approved=true, note="queued for end-of-turn approval")` back to the worker so its `shipSubmission` Promise resolves and the worker's process exits cleanly.
   - Resolves the `delegate` tool call's pending Promise with the artifacts.
   - Registers the artifacts as a `deferred-confirm` handler labelled
     `Delegate (<workerName>)`.
5. The `delegate` tool returns synchronously to the foreman's model
   with a textual summary; multiple `delegate` calls in one turn each
   register their own handler.
6. At `agent_end`, the foreman's `deferred-confirm` collects every
   handler (its own deferred-* operations and one per delegate), shows
   one unified preview, and applies on approval. If the foreman has
   `submitTo` set itself, the artifacts bundle up and ship to the
   foreman's supervisor instead — the recursive shape Just Works.

A foreman that is itself launched as a child of `delegator` works the
same way at every level: each tier's `delegate` is atomic; submissions
flow up through whatever escalation chain is configured.

### Debugging the rails

Set `AGENT_DEBUG=1` in the environment when launching an agent and the
`sandbox` and `no-edit` extensions will dump their resolved tool sets
via `ctx.ui.notify` on `session_start`. Useful when you've added a new
write tool and want to confirm it was picked up by introspection.

The rails — `agent-header`, `agent-footer`, and `deferred-confirm`'s
end-of-turn `ctx.ui.confirm` dialog — only render under a real PTY,
so `pi -p` print mode can't exercise them. For integration testing,
drive a full TUI session under tmux:

```sh
set -a; source models.env; set +a
tmux new-session -d -s pi-test -x 200 -y 50 \
  'AGENT_DEBUG=1 npm run agent -- deferred-writer'
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

## Multi-agent: delegate vs. talk

Two orthogonal extensions cover the two distinct relationships a recipe
might want with another agent. `atomic-delegate` is implicitly wired by
the `agents:` recipe field; `agent-bus` is opt-in via `extensions:` +
`tools:`. A recipe can use either, both, or neither.

### `atomic-delegate` — single-call delegation over the bus

Wired implicitly when the recipe declares `agents: [a, b, …]`. Registers
one tool:

- `delegate({recipe, task, workspace?, timeout_ms?})` — spawns
  `node scripts/run-agent.mjs <recipe>` in a fresh tmpdir scratch
  root, hands it the task, waits for the worker to ship its drafted
  artifacts back as a `submission` envelope, and registers those
  artifacts as a `deferred-confirm` handler so they queue for unified
  end-of-turn approval alongside any of the caller's own deferred-*
  operations. Single atomic call — no separate approve step. Default
  timeout is 5 minutes (measured from the `delegate` call to the
  arrival of the submission).

**Worker habitat overlay.** Each spawned worker is locked to the
caller via a `--topology-overlay` JSON blob set by the extension:

```json
{
  "supervisor": "<callerName>",
  "submitTo": "<callerName>",
  "acceptedFrom": ["<callerName>"],
  "peers": ["<callerName>"],
  "agents": []
}
```

So the worker can only message the caller, can only submit to the
caller, has no further-delegation capability, and won't accept typed
inbound envelopes from anyone else. The overlay overrides whatever
peer fields the worker recipe declares.

**Pre-flight checks** in `delegate.execute`:

1. **Recipe allowlist** — `params.recipe` must be in
   `getHabitat().agents`. Error:
   `delegate: recipe 'X' not in this agent's allowed list […]`.
2. **Recipe exists** — `pi-sandbox/agents/<recipe>.yaml` must exist.

**Workspace bundling.** When `workspace.include: ["a.txt", "sub/"]`
is passed, those relative paths are resolved against the caller's
sandbox and copied into the worker's tmpdir before launch (recursing
into directories). Use this to give the worker read-only context
files (existing code it needs to reference). Paths that escape the
caller sandbox are silently skipped.

**Inbound dispatch.** When the worker ships its submission to the
caller's bus socket, `agent-bus.handleIncoming` invokes
`__pi_atomic_delegate_dispatch__` BEFORE the `acceptedFrom` check, so
dynamically-spawned worker names don't need to live in the caller's
static `acceptedFrom` list. The hook self-gates on its own pending-
workers map (keyed by `<breed>-<recipe>` slug); envelopes from an
unknown sender fall through to the rest of the routing chain.

**Cleanup.** After the worker exits (graceful exit after submission,
or kill on timeout), the scratch tmpdir is removed. The artifacts
themselves are in-memory in the deferred-confirm handler until the
end-of-turn applies (or rejects) them.

Worked examples: `pi-sandbox/agents/deferred/writer-foreman.yaml` (single-
recipe foreman driving `deferred-writer`) and
`pi-sandbox/agents/deferred/delegator.yaml` (general-purpose planner with a
broad allowlist).

### `agent-bus` — async peer messaging (long-lived, named)

Registers three tools and one CLI flag:

- `agent_send({to, body, in_reply_to?})` — fire-and-forget. Connects to
  `${BUS_ROOT}/${to}.sock`, writes one JSON envelope, returns
  `{msg_id, delivered}`. `peer offline` / `timeout` are normal failure
  modes (no retry, no offline queue).
- `agent_inbox({since_ts?, peek?})` — pull buffered envelopes. By
  default returned messages are cleared from the inbox; `peek=true`
  keeps them.
- `agent_list()` — probe `${BUS_ROOT}/*.sock` for live peers; clean up
  stale socks left by crashed peers.
- `--agent-bus-root <dir>` — the rendezvous directory. Resolution
  order: this flag → `$PI_AGENT_BUS_ROOT` → `~/.pi-agent-bus/<basename
  of sandbox-root>`. The runner sets the flag automatically and accepts
  `--agent-bus <dir>` (parallel to `--sandbox <dir>`) to override.

Each agent listens on `${BUS_ROOT}/${name}.sock` (name comes from
`--agent-name`, which the runner sets to a generated
`<breed>-<shortName>` slug — unique per instance — unless the
`-- --agent-name <override>` passthrough wins). The runner probes the
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

Worked example: `pi-sandbox/agents/deferred/peer-chatter.yaml`.

### Why two systems and not one

`delegate` is an atomic blocking call (ephemeral worker, structured
return: artifacts queued); peer-talk is async long-lived messaging
(stable named peers, `pi.sendUserMessage` delivery). Both happen to
ride the same Unix-socket bus protocol — atomic-delegate's wire format
is the same `submission` envelope kind that the supervisor inbound
rail handles — but the recipe-level affordances differ enough that
keeping them as two independent extensions is what lets recipes mix
exactly the relationship they need.

### Verifying the multi-agent rails under tmux

Same pattern as the rails-debug section above. Two panes — note the
explicit `-- --agent-name <override>` on each, which is what lets the
two peers find each other by a stable role name. Without the override
each instance would get a unique generated slug (`<breed>-chatter`),
fine for distinguishing instances in logs but useless for `agent_send`
targeting:

```sh
set -a; source models.env; set +a
tmux new-session -d -s bus-test -x 200 -y 50 \
  'PI_AGENT_BUS_ROOT=/tmp/bus npm run agent -- peer-chatter --sandbox /tmp/p1 -- --agent-name planner'
tmux split-window -t bus-test \
  'PI_AGENT_BUS_ROOT=/tmp/bus npm run agent -- peer-chatter --sandbox /tmp/p2 -- --agent-name worker-a'
sleep 5
tmux send-keys -t bus-test:0.0 'call agent_list, then agent_send to worker-a with body "ping"' Enter
sleep 30
tmux capture-pane -t bus-test:0.1 -p   # expect "[from planner] ping" on next user turn
tmux send-keys -t bus-test:0.0 '/quit' Enter
tmux send-keys -t bus-test:0.1 '/quit' Enter
```

To exercise the **atomic delegate** end-to-end, drive
`writer-foreman` (single file):

```sh
set -a; source models.env; set +a
mkdir -p /tmp/foreman-test
tmux new-session -d -s foreman -x 200 -y 50 \
  'AGENT_DEBUG=1 npm run agent -- writer-foreman --sandbox /tmp/foreman-test'
sleep 5
tmux send-keys -t foreman \
  'draft hello.txt with text "Hi"' Enter
sleep 60                              # foreman calls delegate; worker drafts and
                                      # ships submission; foreman queues artifacts;
                                      # end-of-turn approval renders.
tmux capture-pane -t foreman -p       # expect a Delegate (...) section in the
                                      # approval preview.
tmux send-keys -t foreman 'y' Enter   # approve at end-of-turn dialog
sleep 5
ls /tmp/foreman-test/hello.txt        # file present with "Hi"
tmux send-keys -t foreman '/quit' Enter
```

For **multiple delegates in one turn** (each surfaces as a separate
section in the unified preview):

```sh
tmux send-keys -t foreman \
  'draft two files: hello.txt saying "Hi" and world.txt saying "World"' Enter
sleep 120   # foreman calls delegate twice; both submissions queue;
            # one unified end-of-turn dialog shows both Delegate sections.
tmux send-keys -t foreman 'y' Enter
sleep 5
ls /tmp/foreman-test/   # hello.txt and world.txt both present
```

Negative cases worth probing manually:

- **Loud fail under print mode**: run `npm run agent -- deferred-writer
  -p "draft x.txt"` directly. With no UI, the worker exits but stderr
  contains `[deferred] dropped: no UI available`. (Cross-agent
  approval forwarding now flows over the bus, not through `--rpc-sock`.)
- **Recipe not allowed**: prompt foreman with `recipe:
  "deferred-editor"` → `delegate: recipe 'deferred-editor' not in
  this agent's allowed list [deferred-writer]`.
- **Schema rejection**: scratch recipe with
  `extensions: [atomic-delegate]` and no `agents:` → runner exits with
  `loads extension 'atomic-delegate' but has no 'agents:' list`.

## Supervisor inbound rail — Phase 3c

The **supervisor** extension (`pi-sandbox/.pi/extensions/supervisor.ts`) implements
the inbound review loop described in [ADR-0003](../docs/adr/0003-supervisor-llm-in-review-loop.md).
It is auto-wired by the runner when a recipe declares any of the supervisory
peer fields (`acceptedFrom`, `supervisor`, or `submitTo`). The extension registers
the `respond_to_request` tool and a globalThis dispatch hook that `agent-bus` calls
when a typed non-message envelope arrives.

### Automatic wiring

```yaml
# Any of these triggers auto-load of the supervisor extension +
# respond_to_request tool:
acceptedFrom: [worker-a, worker-b]
supervisor: lead-hare
submitTo: canonical-store
```

Explicitly declaring `extensions: [supervisor]` or `tools: [respond_to_request]`
**without** any of those fields causes the runner to `die()` with a clear error.

### Inbound envelope kinds handled

| Kind | Source | Rail action |
|------|--------|-------------|
| `approval-request` | peer in `acceptedFrom` | Queued; model prompted |
| `submission` | peer in `acceptedFrom` | Queued; model prompted |
| Either kind from unknown peer | anyone not in `acceptedFrom` | Dropped silently (stderr under `AGENT_DEBUG=1`) |
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

The model-facing prompt fragment (`supervisor.prompt.md`) is loaded automatically
when the supervisor extension is active; it contains action descriptions and usage
examples.

### Testable core

The action routing, acceptedFrom enforcement, and revision cap all live in
`pi-sandbox/.pi/extensions/_lib/supervisor-inbox.ts` with a matching
`_lib/supervisor-inbox.test.ts`. The `supervisor.ts` extension is a thin pi
wrapper; tests can exercise the full action graph without a live model.

### Escalation and the `_lib/escalation.ts` primitive

`requestHumanApproval` lives in `_lib/escalation.ts` and is imported by
`deferred-confirm.ts`. After Phase 5 it routes only `ctx.hasUI` →
`ctx.ui.confirm` or loud-fails to stderr; cross-agent escalation flows
over the bus as an `approval-request` envelope handled by the supervisor
rail (the `escalate` action sends to `getHabitat().supervisor` directly,
no rpc-sock fallback).

## Topology YAML

A topology YAML describes the full set of nodes in a mesh and their peer
relationships. `npm run mesh -- <file.yaml>` launches all nodes in parallel;
`scripts/launch-mesh.mjs` is the entry point.

### Schema

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
  - name: authority             # instance name on the bus (--agent-name)
    recipe: mesh-authority      # pi-sandbox/agents/<recipe>.yaml
    sandbox: /tmp/mesh/auth     # optional; auto-created under /tmp if omitted
    task: "..."                 # optional; sent as the first RPC prompt

  - name: human
    type: relay                 # spawns human-relay.mjs; no LLM

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

### Group references

Any string value in `acceptedFrom`, `peers`, or a `group_bindings` array that
starts with `@` is expanded to the group's member list at launch time. The bus
always sees concrete peer names — groups are a topology-level authoring
convenience, not a bus-level concept.

```yaml
groups:
  workers: [w1, w2, w3]
nodes:
  - name: authority
    recipe: mesh-authority
    acceptedFrom: ["@workers"]  # expands to [w1, w2, w3] before launch
```

### Resolution order

For a given node, the effective Habitat overlay is computed as:

1. **Group bindings** — for each group the node belongs to (in declaration
   order), apply the binding's fields. Later groups overwrite earlier ones for
   scalar fields; array fields are also replaced.
2. **Per-node fields** — override everything from group bindings.
3. **Recipe fields** — used for any field not set by the topology at all.

`@group` refs in binding arrays are expanded during resolution. A ref to an
undefined group is a hard launch error.

### Validation

`scripts/launch-mesh.mjs` validates the full topology before spawning any node:

- Duplicate node names → error.
- `@group` references to undefined groups → error.
- `acceptedFrom` / `peers` referencing a name not in `nodes` → error.

### Launcher integration

For each pi-agent node the launcher passes `--topology-overlay <json>` in the
passthrough args. `scripts/run-agent.mjs` parses this flag and merges the
resolved fields into `habitatSpec` (topology fields take precedence over recipe
values). The `habitat` baseline extension materialises `habitatSpec` at
`session_start`; all rails read peer relationships from `getHabitat()`.

### Example — grouped mesh

`pi-sandbox/meshes/grouped-mesh.yaml` shows a complete topology that exercises
groups, group bindings, and per-node overrides. The existing
`pi-sandbox/meshes/authority-mesh.yaml` (no peer fields) continues to launch
unchanged.

## Manual smoke test for the Ralph-Loop AFK trunk

The Ralph-Loop mesh runtime mode (`npm run mesh -- --project … --feature …`,
issue PRD-0001 #03) drives the AFK trunk against a real project. Use the
fixture below to exercise it end-to-end without touching a real codebase.
The fixture uses one trivial `ready-for-agent` issue; the Foreman should
claim it, run the Ralph Loop, auto-merge into `feature/v1-fixture`, and
move the issue to `issues/closed/`.

### One-time fixture setup

Note the `git checkout -b feature/v1-fixture` — the issue file MUST land
on the feature branch, not on `main`. The Kanban worktree checks out the
feature branch and only sees what's there.

```sh
mkdir -p /tmp/fixture-project && cd /tmp/fixture-project
git init -b main
echo '{"name":"fixture","scripts":{"test":"echo ok"}}' > package.json
git add . && git commit -m "init"

# Switch to the feature branch BEFORE creating the issue file.
git checkout -b feature/v1-fixture

mkdir -p .scratch/v1-fixture/issues
cat > .scratch/v1-fixture/issues/01-trivial.md <<'EOF'
Status: ready-for-agent

# Trivial issue
## What to build
Add a trailing-newline comment to package.json.
EOF

git add . && git commit -m "fixture issue"
git checkout main   # back to main; the launcher checks out the feature
                    # branch into .mesh-features/v1-fixture/kanban/ for you
```

### Launching the mesh

From the AgentFactory repo root, with `models.env` sourced:

```sh
cd ~/Git/AgentFactory   # or wherever your AgentFactory checkout is
set -a; source models.env; set +a
npm run mesh -- --project /tmp/fixture-project --feature v1-fixture
```

What you should see, in order:

```
launch-mesh: adding kanban worktree at /tmp/fixture-project/.mesh-features/v1-fixture/kanban
launch-mesh: starting Kanban (runtime mode)
[kanban] … started on bus as "kanban" (…)
[kanban] … project=/tmp/fixture-project feature=v1-fixture
[kanban] … issuesDir=…/.scratch/v1-fixture/issues
[kanban] … maxConcurrent=1 pollInterval=2000ms
[kanban] … dispatching Foreman for v1-fixture/01-trivial
[foreman:01-trivial] …pi output as the model executes the workflow…
[kanban] … Foreman for v1-fixture/01-trivial exited (code=0 …)
```

After the Foreman exits cleanly, the fixture project's `feature/v1-fixture`
branch should have a merge commit, and `.scratch/v1-fixture/issues/01-trivial.md`
should have moved to `.scratch/v1-fixture/issues/closed/01-trivial.md` with
`Status: closed`.

### Common gotchas

- **Dispatch loop with sub-second exits** — if you see
  `[kanban] … dispatching Foreman …` followed by
  `[kanban] … Foreman … exited (code=0 …)` every 2s with no
  `[foreman:…]` output between them, the Foreman is exiting silently before
  the model boots. The Kanban's spawn args should include
  `--`, `-p`, `<initial prompt>` so pi runs in headless print mode; without
  `-p` and without a TTY, pi exits in <1s.
- **Issue file on the wrong branch** — if the Kanban polls without ever
  dispatching, the issue file is probably on `main` instead of
  `feature/v1-fixture`. Confirm with
  `ls /tmp/fixture-project/.mesh-features/v1-fixture/kanban/.scratch/v1-fixture/issues/`.
  If the directory is empty, `git checkout feature/v1-fixture` in the kanban
  worktree and `git merge main --ff-only` to pull the fixture commit forward.
- **`kanban: failed to bind bus socket: name "kanban" already held by a live peer`** — a previous mesh
  invocation is still running. Find and kill it (`pgrep -f kanban.mjs`) or
  unlink the stale sock at `~/.pi-agent-bus/<bus-root>/kanban.sock` if no
  process owns it.

### Cleanup

```sh
# Stop the mesh first (Ctrl-C the kanban).
cd /tmp/fixture-project
git worktree remove .mesh-features/v1-fixture/kanban
rm -rf .mesh-features
# Or just nuke the whole fixture: rm -rf /tmp/fixture-project
```
