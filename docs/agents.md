# Composing agents — `npm run agent`

Day-to-day, the way to launch a focused agent is `npm run agent -- <name>`.
The runner (`scripts/run-agent.mjs`) reads a YAML recipe from
`pi-sandbox/agents/<name>.yaml`, resolves the model tier, and execs `pi`
from the directory you invoked it from (or `--sandbox <dir>`). Every
agent gets six baseline extensions:

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
  shows the agent name (bold accent), optionally suffixed dim with the
  model tier (e.g. `deferred-writer · Task Rabbit`), and the recipe's
  `description:` field on the next line (dim). Reads the `--agent-name`,
  `--agent-description`, and `--agent-tier` flags; the runner sets all
  three from the recipe filename, `description:`, and `model:` (the
  tier suffix is skipped when `model:` is a literal model ID rather
  than a tier var). Each flag can be passed on the `npm run agent --`
  line to override the recipe (passthrough flags come after
  recipe-derived ones, so the CLI value wins).
- `agent-footer` — replaces pi's default footer. Line 1 shows the
  sandbox root on the left and the comma-separated active tools (from
  `pi.getActiveTools()`, i.e. the recipe's `tools:` allowlist plus any
  extension-registered tools) on the right. Line 2 shows `$cost` and
  the context-usage percent on the left, model id on the right —
  pi's default token-flow stats (↑input, ↓output, cache R/W, context
  window size) are intentionally dropped. Line 3 is the
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

  **Approval routing** is handled by an exported helper,
  `requestHumanApproval(ctx, pi, {title, summary, preview}) →
  Promise<boolean>`, that picks the right channel:
  - `ctx.hasUI` → renders `ctx.ui.confirm` locally (this terminal is
    the human's).
  - else `--rpc-sock` flag set → forwards over a unix socket to the
    parent agent's RPC server (parent itself recurses if it's also
    headless, so escalations walk up the chain to whoever can answer).
  - else loud-fails to stderr (`[deferred] dropped: no UI and no
    --rpc-sock`) and returns `false` — replacing today's silent drop
    of queued drafts under `pi -p`.

  The same primitive is reused by `agent-spawn`'s
  `approve_delegation({escalate: true})`, so any agent works whether
  it's running standalone or as a child.

  RPC protocol (newline-delimited JSON, single round-trip):
  ```
  client → server : {type: "request-approval", title, summary, preview}
  server → client : {type: "approval-result", approved: boolean}
  ```
  IPC failures (parent died, EPIPE, malformed reply, server closed
  without replying) settle as `approved: false`. No retries, no
  offline queueing.

  When no UI is present, the apply-loop's status notifications
  (`writes applied: …`, `edits applied: …`, etc.) are routed to
  stdout as `[deferred] …` lines so the parent's `delegate` /
  `approve_delegation` tool result captures them.

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
description: Drafts files...      # optional; shown by agent-header in the TUI
prompt: |                         # replaces pi's default system prompt
  You are a careful drafter...
tools: [read, ls, grep, deferred_write]
extensions: [deferred-write]      # merged with the [sandbox, no-startup-help, agent-header, agent-footer, hide-extensions-list, deferred-confirm] baseline
skills: [pi-agent-builder]        # optional; resolved against pi-sandbox/skills/
provider: openrouter              # optional; defaults to openrouter
noEditAdd: [my_writer]            # optional; force-include in no-edit rail
noEditSkip: [deferred_write]      # optional; exempt from no-edit rail
agents: [deferred-writer]         # optional; recipes this agent may delegate to
```

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

- adds `agent-spawn` to `extensions:`, and
- adds `delegate` and `approve_delegation` to `tools:`.

Explicit duplicates in the recipe are fine. The inverse is rejected
loudly: declaring `extensions: [agent-spawn]` or
`tools: [delegate | approve_delegation]` without `agents:` causes the
runner to `die()` so the allowlist is never accidentally empty. To
disable delegation, drop the `agents:` field entirely.

## Where agent code lives

| Location | Behavior |
| --- | --- |
| `pi-sandbox/agents/<name>.yaml` | Agent recipe consumed by `npm run agent` |
| `pi-sandbox/.pi/extensions/<name>.ts` | Project-local extension, auto-discovered by `npm run pi`; loaded explicitly by `npm run agent` when listed in a recipe |
| `~/.pi/agent/extensions/<name>.ts` | Global extension, hot-reloadable via `/reload` |
| `pi -e ./path.ts` | One-off test load (not hot-reloadable) |

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
  `deferred_write`. Override per recipe with `noEditAdd` (force-include)
  or `noEditSkip` (force-exclude). Drop the extension entirely if you
  want an agent that can overwrite or edit existing files.

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

## Worked example: writer-foreman (parent-driven approval over RPC)

`pi-sandbox/agents/writer-foreman.yaml` is a Lead-tier foreman that
decomposes a drafting request and dispatches focused batches to a
`deferred-writer` child. The recipe declares only:

```yaml
agents: [deferred-writer]
tools: [read, ls, grep, find]
```

The runner implicitly loads `agent-spawn` and adds `delegate` +
`approve_delegation` to the tool allowlist, and pushes
`--allowed-agents deferred-writer` so the child recipe is locked.

Flow per batch:

1. Foreman calls `delegate({recipe: "deferred-writer", task: "…"})`.
2. The runner spawns a child `pi -p` with `--rpc-sock <path>`.
3. Child drafts in memory, hits `agent_end`. Its `deferred-confirm`
   has no `ctx.hasUI` (print mode) but does have `--rpc-sock`, so
   `requestHumanApproval` opens the socket and sends
   `request-approval` with the preview.
4. Foreman's per-call RPC server stashes the request in the
   pending-delegations registry; `delegate` returns the preview +
   `delegation_id` to the foreman LLM.
5. Foreman LLM reads the preview, decides:
   - `approve_delegation({id, approved: true})` — auto-approve.
   - `approve_delegation({id, approved: false})` — discard.
   - `approve_delegation({id, escalate: true})` — ask the human via
     `requestHumanApproval`, which renders `ctx.ui.confirm` in the
     foreman's terminal (or recursively forwards if the foreman is
     itself a child).
6. The decision is sent over the open RPC connection. Child resumes,
   applies (or discards) the drafts, prints `[deferred] writes
   applied: …` to stdout, exits.
7. `approve_delegation` returns the captured stdout to the foreman.

A foreman that is itself launched as a child — e.g.
`delegator → writer-foreman → deferred-writer` — works the same way:
its own `requestHumanApproval` reads its own `--rpc-sock` and forwards
escalations one more hop up. The chain bottoms out at the human.

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
might want with another agent. `agent-spawn` is implicitly wired by the
`agents:` recipe field; `agent-bus` is opt-in via `extensions:` +
`tools:`. A recipe can use either, both, or neither.

### `agent-spawn` — blocking delegation with parent-driven approval

Wired implicitly when the recipe declares `agents: [a, b, …]`. Registers
two tools:

- `delegate({recipe, task, sandbox?, timeout_ms?})` — spawns
  `node scripts/run-agent.mjs <recipe> --sandbox <dir> -p <task>
  -- --rpc-sock <path>` as a subprocess, captures stdout (truncated to
  20 KB), and races two outcomes: child exits without queuing drafts
  (returns captured stdout, today's behavior) OR child sends a
  `request-approval` over the per-call RPC socket (returns the preview
  + a `delegation_id` to the parent LLM with the child paused).
  Forwards the parent's `AbortSignal`. Default timeout is 5 minutes.
- `approve_delegation({id, approved, escalate?, comment?})` — resumes
  a paused delegation. Pass `approved: true|false` for the parent LLM
  to decide directly; pass `escalate: true` to ask the human via
  `requestHumanApproval` (which recurses up the parent chain if the
  parent itself is a child via `--rpc-sock`). Returns the child's
  final captured stdout, including the `[deferred] writes applied: …`
  lines from the apply phase.

Why two tools: putting the parent LLM in the approval loop requires
returning the preview to the LLM mid-delegation; a single blocking
`delegate` can't do that. Splitting the flow gives the LLM full
control without inventing new pi primitives.

**Pre-flight checks** in `delegate.execute` (in order):

1. **Recipe allowlist** — `params.recipe` must be in
   `--allowed-agents` (set by the runner from `agents:`). Error:
   `delegate: recipe 'X' not in this agent's allowed list […]`.
2. **Sandbox containment** — `params.sandbox || ctx.cwd` must equal
   or be inside the parent's sandbox root (parent root = `ctx.cwd`
   because the runner spawns pi with `cwd = sandboxRoot`). Children
   may run in subdirectories of the parent's sandbox but never
   anywhere outside it. Error: `delegate: sandbox '…' escapes parent
   root '…'`.

**Pending delegations** are tracked in a globalThis registry
(`__pi_delegate_pending__`) keyed by `delegation_id`. Each entry
holds the child process handle, the open RPC connection, the
preview, and the timeout budget. A watchdog enforces `timeout_ms`
across the whole life of the delegation (delegate + LLM thinking +
approve_delegation); exceeding it sends `approved: false` to the
child and kills the process. `process.once("exit")` cleanup walks
the registry, denies all pending requests, kills surviving children,
and unlinks sockets.

**Sockets** are per-call at
`${os.tmpdir()}/pi-rpc-${pid}-${randomUUID()}.sock`, deliberately
outside any sandbox root so neither `sandbox` nor `no-edit` flag
them as escapes.

Worked examples: `pi-sandbox/agents/writer-foreman.yaml` (single-
recipe foreman driving `deferred-writer`) and
`pi-sandbox/agents/delegator.yaml` (general-purpose planner with a
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
`--agent-name`, which the runner sets from the recipe filename or a
passthrough override). Incoming messages buffer in an in-memory inbox
and, between turns, are pushed into the agent's next turn via
`pi.sendUserMessage("[from <peer>] <body>")`. Mid-turn arrivals are
held in a `pendingDuringTurn` queue and drained at `turn_end` so the
live LLM call is never interrupted.

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

Spawn is a blocking function call (ephemeral, anonymous handle,
structured return); peer-talk is async messaging (long-lived, stable
name, `pi.sendUserMessage` delivery). Forcing delegation through the bus
would make every subtask allocate a name and burn turns polling an
inbox; forcing peers through `createAgentSession` doesn't work at all
since peers are independent processes. Keeping them as two independent
extensions lets recipes mix exactly the relationship they need.

### Verifying the multi-agent rails under tmux

Same pattern as the rails-debug section above. Two panes:

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

For non-paused `delegate`, run `npm run agent -- delegator --sandbox
/tmp/p` and prompt *"delegate to recipe peer-chatter with task 'list
/tmp'"* — the child spawns, runs in print mode, exits, and the
captured stdout comes back as the tool result.

For the **parent-driven approval** flow, drive `writer-foreman` end-
to-end:

```sh
set -a; source models.env; set +a
mkdir -p /tmp/foreman-test
tmux new-session -d -s foreman -x 200 -y 50 \
  'AGENT_DEBUG=1 npm run agent -- writer-foreman --sandbox /tmp/foreman-test'
sleep 5
tmux send-keys -t foreman \
  'delegate to deferred-writer with task "draft hello.txt with text Hi"' Enter
sleep 90                              # foreman delegates, child pauses,
                                      # foreman reads preview, calls
                                      # approve_delegation({approved: true})
tmux capture-pane -t foreman -p       # expect "[deferred] writes applied: hello.txt"
ls /tmp/foreman-test/hello.txt        # file present with "Hi"
tmux send-keys -t foreman '/quit' Enter
```

Negative cases worth probing manually:

- **Foreman escalates**: ambiguous task → expect
  `approve_delegation({escalate: true})` and a `ctx.ui.confirm`
  dialog in the foreman's terminal.
- **Recursive escalation**: wrap with `delegator` (`delegator →
  writer-foreman → deferred-writer`) and force the foreman to
  escalate; the prompt surfaces in the *delegator's* terminal.
- **Loud fail**: run `npm run agent -- deferred-writer -p "draft
  x.txt"` directly. With no UI and no `--rpc-sock`, the child exits
  but stderr contains `[deferred] dropped: no UI and no --rpc-sock`.
- **Sandbox escape**: prompt foreman with `sandbox: "/tmp/elsewhere"`
  → `delegate: sandbox '…' escapes parent root '…'`.
- **Recipe not allowed**: prompt foreman with `recipe:
  "deferred-editor"` → `delegate: recipe 'deferred-editor' not in
  this agent's allowed list [deferred-writer]`.
- **Schema rejection**: scratch recipe with `extensions: [agent-spawn]`
  and no `agents:` → runner exits with `loads extension 'agent-spawn'
  but has no 'agents:' list`.
