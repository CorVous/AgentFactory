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

Collision detection runs in two places: `agent-spawn` tracks in-flight
sibling slugs in its `state.pending` registry so two parallel
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
  extension-registered tools) on the right. `delegate` and
  `approve_delegation` are filtered out of the tool list because every
  delegating agent has them — they tell the user nothing about what
  the recipe can actually do, and the agents-it-can-spawn list on
  line 2 already conveys delegation capability. Line 2 (when populated)
  shows the recipe's `skills:` list on the left and the recipes this
  agent may `delegate` to on the right — both as plain comma-separated
  lists, no labels, matching line 1's bare style. Read from the
  `PI_AGENT_SKILLS` / `PI_AGENT_AGENTS` env vars set by the runner
  (pi.getFlag is scoped per-extension, so cross-extension flag reads
  have to bounce through env, mirroring how `agent-status-reporter`
  reads `--rpc-sock`); the line is skipped entirely when both lists
  are empty. Line 3 shows `$cost` and the context-usage percent on
  the left, model id on the right — pi's default token-flow stats
  (↑input, ↓output, cache R/W, context window size) are intentionally
  dropped. Line 4 is the extension-status line.
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
- `agent-status-reporter` — child-side. While `--rpc-sock` is set,
  pushes `{context %, cost, turn, state}` snapshots over the per-call
  RPC socket whenever the agent crosses a turn / tool / response
  boundary (throttled to one write per 250 ms). Tagged with a
  `{type:"hello", id}` envelope on first send so the parent can
  reuse one conn per child. No-op for top-level runs.
- `agent-receive` — child-side. Opens a SECOND connection to the
  parent's RPC socket (separate from the status conn), tagged
  `{type:"hello", id, role:"control"}`. Listens for control
  envelopes from the parent's `/view`: `{type:"user-message",body}`
  is queued as the child's next user turn via `pi.sendUserMessage`;
  `{type:"start-takeover"}` flips an internal `released` flag so
  `agent_end` parks on a never-resolving Promise (keeping the child
  alive while a human watches it); `{type:"release"}` flips the flag
  back so the next `agent_end` exits cleanly. No-op for top-level
  runs (no `PI_RPC_SOCK`). Failure (parent died, EPIPE) flips
  `released` back to `true` so the child doesn't park forever.
- `agent-view` — parent-side. Registers `/view <agent>` and
  `/back` (alias `/unview`) commands, the viewer widget at
  `aboveEditor`, and the approval interceptor on
  `globalThis.__pi_view_interceptor__`. The interceptor is consulted
  by `agent-spawn`'s RPC `request-approval` handler: while a child
  is being viewed, the parent's `ctx.ui.confirm` runs locally and
  the result is written back over the same conn — bypassing the
  foreman LLM entirely. While viewing, the `input` event handler
  returns `{action: "handled"}` and forwards the typed text over
  the child's control conn (via `globalThis.__pi_delegate_send__`)
  instead of triggering a parent-LLM turn. Dormant when no
  delegations exist — safe in the baseline for non-delegating
  recipes.

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
extensions: [deferred-write]      # merged with the [sandbox, no-startup-help, agent-header, agent-footer, hide-extensions-list, deferred-confirm, agent-status-reporter, agent-receive, agent-view] baseline
skills: [pi-agent-builder]        # optional; resolved against pi-sandbox/skills/
provider: openrouter              # optional; defaults to openrouter
noEditAdd: [my_writer]            # optional; force-include in no-edit rail
noEditSkip: [deferred_write]      # optional; exempt from no-edit rail
agents: [deferred-writer]         # optional; recipes this agent may delegate to
```

### `prompt:` and extension fragments

Tool-usage rules live next to the extensions that register the tools, not
in each recipe's `prompt:`. For each loaded extension `<name>`, the runner
looks for a sibling `pi-sandbox/.pi/extensions/<name>.prompt.md` and, if
present, prepends it to the system prompt that pi receives. Recipes only
need to describe the agent's role; the standard rules for `deferred_write`,
`deferred_edit`, `delegate`, etc. come from the fragments.

Two conditional fragments are gated by the runner so they don't appear
when irrelevant:

- `deferred-confirm.prompt.md` (apply order, atomic batch semantics) is
  loaded only when at least one `deferred-*` tool extension is active —
  baseline `deferred-confirm` itself is a no-op without one.
- `agent-spawn.approval.prompt.md` (the draft-approval workflow) is loaded
  only when at least one recipe in `agents:` declares a `deferred-*`
  extension. A delegator whose children never queue drafts gets the basic
  `delegate` / `approve_delegation` mechanics from `agent-spawn.prompt.md`
  but no approval-flow guidance.

Final order seen by the model: baseline-extension fragments → recipe-
extension fragments → `agent-spawn` fragments (when implicit) → recipe
`prompt:`. Edit a fragment to change behaviour for every recipe that
loads its extension; edit a recipe's `prompt:` for that one agent only.

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

- adds `agent-spawn` to `extensions:`,
- adds `delegation-boxes` to `extensions:` (renders one status box
  per pending delegation above the input editor — name, 3-cell
  context bar, cost, turn, state — laid out 2 or 3 boxes per row
  depending on terminal width), and
- adds `delegate` and `approve_delegation` to `tools:`.

Explicit duplicates in the recipe are fine. The inverse is rejected
loudly: declaring `extensions: [agent-spawn]` or
`tools: [delegate | approve_delegation]` without `agents:` causes the
runner to `die()` so the allowlist is never accidentally empty. To
disable delegation, drop the `agents:` field entirely.

The boxes are populated by the **`agent-status-reporter`** baseline
extension running inside each delegated child. It self-gates on
`--rpc-sock` (a no-op for top-level runs) and pushes newline-delimited
JSON envelopes over the existing per-call socket whenever it crosses a
turn / tool / provider-response boundary, throttled to one write per
250 ms. Envelopes:

```jsonc
// Once per child connection. Tags the conn so subsequent status
// envelopes can omit `delegation_id`.
{"type": "hello", "id": "<delegation_id>"}

// Many per child. Cached on the parent's PendingDelegation entry
// and rendered by delegation-boxes.
{
  "type": "status",
  "delegation_id": "<optional once tagged>",
  "agent_name": "<from --agent-name>",
  "model_id": "<ctx.model.id>",
  "context_pct": 12.4,
  "context_tokens": 2480,
  "context_window": 200000,
  "cost_usd": 0.0123,
  "turn_count": 3,
  "state": "running" | "paused" | "settled"
}
```

The parent's `agent-spawn` server consumes both envelope types on the
same socket as the existing `request-approval` flow; a long-lived
status conn and short-lived approval conn(s) coexist without
coordination. Status updates are best-effort: connect failures and
mid-session disconnects retry once at 500 ms then give up silently.
The parent stamps `state: "paused"` when the child sends
`request-approval` and `state: "settled"` once the child exits, so the
final box transitions are visible even if the reporter dropped its
connection. The 3-cell context bar uses the same eighths-block format
as the footer (`renderBar(pct, 3)` from
`pi-sandbox/.pi/extensions/_lib/context-bar.ts`).

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

Flow per batch (or per parallel set of batches):

1. Foreman calls `delegate({recipe: "deferred-writer", task: "…"})`.
   Returns immediately with a `delegation_id`; the child is spawning
   in the background. Repeat for each independent batch before
   collecting any results — all children run in parallel.
2. The runner spawns a child `pi -p` with `--rpc-sock <path>`.
3. Child drafts in memory, hits `agent_end`. Its `deferred-confirm`
   has no `ctx.hasUI` (print mode) but does have `--rpc-sock`, so
   `requestHumanApproval` opens the socket and sends
   `request-approval` with the preview.
4. The foreman's per-call RPC server receives the request. The child
   remains paused on the open socket.
5. Foreman calls `approve_delegation({id})` (no decision yet). Blocks
   until the child settles, then returns the preview.
6. Foreman LLM reads the preview, decides:
   - `approve_delegation({id, approved: true})` — auto-approve.
   - `approve_delegation({id, approved: false})` — discard.
   - `approve_delegation({id, escalate: true})` — ask the human via
     `requestHumanApproval`, which renders `ctx.ui.confirm` in the
     foreman's terminal (or recursively forwards if the foreman is
     itself a child).
7. The decision is sent over the open RPC connection. Child resumes,
   applies (or discards) the drafts, prints `[deferred] writes
   applied: …` to stdout, exits.
8. `approve_delegation` returns the captured stdout (plus the preview
   as an audit trail) to the foreman.

Shortcut: `approve_delegation({id, approved: true})` combines steps 5–6
into one call — it blocks until the child settles, sends the decision
immediately, and includes the preview in the tool result for audit.

A foreman that is itself launched as a child — e.g.
`delegator → writer-foreman → deferred-writer` — works the same way:
its own `requestHumanApproval` reads its own `--rpc-sock` and forwards
escalations one more hop up. The chain bottoms out at the human.

## Viewing a delegated child: `/view <agent>`

While a foreman is running children in the background you can switch
the parent's TUI into a live view of any one of them with `/view
<name-or-prefix>`. The match runs against the child's
`<breed>-<shortName>` slug (an exact match wins; otherwise unique
case-insensitive prefix; otherwise unique substring). The viewer
widget renders above the input editor and shows:

- A header with the prettified name, current state
  (running / paused / settled), context %, cumulative cost, and turn
  count — all read from the existing status snapshots that
  `agent-status-reporter` already pushes.
- The child's live transcript (last N lines of its `pi -p` stdout,
  sized to the visible terminal). The viewer subscribes to the
  per-delegation `streamSubscribers` set on `agent-spawn`'s registry
  entry, so chunks arrive as the child emits them.
- A footer hint summarising the controls.

Three things happen the moment view-mode is entered:

1. The parent sends `{type: "start-takeover"}` over the child's
   control conn. `agent-receive` flips `released = false`, so the
   child's next `agent_end` parks on a Promise instead of exiting at
   natural turn-end.
2. `globalThis.__pi_view_interceptor__` is consulted by
   `agent-spawn`'s RPC handler. While the viewed child is paused for
   approval, the request is rendered as `ctx.ui.confirm` in the
   parent's terminal and the result is written back over the same
   conn — bypassing the foreman LLM. (If the child paused *before*
   the user typed `/view`, `agent-view` finds the buffered request
   on `entry.pendingApprovalReq` and pops the dialog immediately.)
3. The `input` event handler returns `{action: "handled"}` for any
   non-slash text typed into the editor and forwards it as
   `{type: "user-message", body}` over the control conn —
   `agent-receive` queues it via `pi.sendUserMessage` for the
   child's next turn. The forwarded text is echoed into the viewer
   transcript so the user sees their own messages.

`/back` (or `/unview`) sends `{type: "release"}` to the child,
unsubscribes the transcript, hides the viewer, and returns control
to the parent. The child exits at its next `agent_end`. The
foreman's `approve_delegation` call (which has been parked the whole
time on `entry.settled`) sees the child as exited-without-pending,
returns the captured stdout, and the foreman LLM resumes. **The
foreman is parked for the whole duration of the takeover** — that's
the intended semantics.

End-to-end under tmux:

```sh
set -a; source models.env; set +a
mkdir -p /tmp/view-test
tmux new-session -d -s view -x 200 -y 50 \
  'AGENT_DEBUG=1 npm run agent -- writer-foreman --sandbox /tmp/view-test'
sleep 5
tmux send-keys -t view 'draft three files in parallel: hello.txt, world.txt, foo.txt' Enter
sleep 30
tmux capture-pane -t view -p | grep -E 'Cottontail|Rex|Holland|Dutch'
                                                  # confirm boxes show breeds
tmux send-keys -t view '/view cottontail-writer' Enter   # or whichever rolled
sleep 2
tmux capture-pane -t view -p                      # expect viewer panel

# Send a follow-up user message into the child mid-flight (takeover):
tmux send-keys -t view 'also append a footer line saying "fin."' Enter
sleep 30                                          # child receives
                                                  # user-message envelope

# Approval prompt comes up locally (interceptor in action):
tmux capture-pane -t view -p | grep -i 'approve'
tmux send-keys -t view 'y' Enter                  # human handles approval
sleep 5
tmux send-keys -t view '/back' Enter              # release the child
sleep 5
ls /tmp/view-test/                                # hello.txt present
                                                  # world.txt and foo.txt
                                                  # also present (foreman
                                                  # auto-approved them)
tmux send-keys -t view '/quit' Enter
```

Negative cases worth probing:

- `/view nonexistent` → `view: no delegation matches 'nonexistent'.
  pending: …` notification, no state change.
- `/view writer` (when 3 writers are pending) → `view: ambiguous: …`
  with the matching agent names.
- `/view` while no children are running → `view: no pending
  delegations`.
- `/view <name>` while already viewing another → switches: tears
  down the old subscription, sends `release` to the old child, then
  `start-takeover` to the new one.
- `/back` with no active view → `view: not currently viewing
  anything`.
- Child errors out / times out while viewed → the registry entry
  disappears, the viewer's render auto-detects the missing entry
  and renders a `── settled · /back to dismiss ──` line.
- Recursive setup (`delegator → writer-foreman → deferred-writer`):
  `/view` only resolves at the level with a real UI. The inner
  foreman has `--rpc-sock` instead of `ctx.hasUI`, so its
  interceptor's `ctx.ui.confirm` falls through `requestHumanApproval`
  to the parent chain — the prompt walks up one more hop
  automatically.

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

### `agent-spawn` — non-blocking delegation with parent-driven approval

Wired implicitly when the recipe declares `agents: [a, b, …]`. Registers
two tools:

- `delegate({recipe, task, sandbox?, timeout_ms?})` — spawns
  `node scripts/run-agent.mjs <recipe> --sandbox <dir> -p <task>
  -- --rpc-sock <path>` as a subprocess and returns immediately with
  a `delegation_id`. The child runs in the background. The parent LLM
  can call `delegate` multiple times before calling `approve_delegation`
  for any of them — all children spawn in parallel. Default timeout is
  5 minutes (measured from the `delegate` call).
- `approve_delegation({id, approved?, escalate?, comment?})` — the join
  point. Blocks until the child settles, then:
  - **Child exited without drafts**: returns captured stdout; no
    decision needed.
  - **Child paused, no decision given**: returns the preview so the
    parent LLM can review it. Call again with `approved: true|false`
    to send the decision.
  - **Child paused, decision given**: sends the decision, waits for
    the child to finish, returns captured stdout plus the preview as
    an audit trail.
  - **`escalate: true`**: asks the human via `requestHumanApproval`
    (recurses up the parent chain if the parent itself is a child via
    `--rpc-sock`).

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
(`__pi_delegate_pending__`) keyed by `delegation_id`. Each entry holds
the child process handle, a `settled` promise (resolves when the child
exits or sends a `request-approval`), and a `resolvedConn` field set
once the child pauses. A watchdog enforces `timeout_ms` across the whole
life of the delegation (delegate + LLM thinking + approve_delegation);
exceeding it sends `approved: false` to the child (if paused) and kills
the process. `process.once("exit")` cleanup walks the registry, denies
all pending requests, kills surviving children, and unlinks sockets.

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

For non-paused `delegate`, run `npm run agent -- delegator --sandbox
/tmp/p` and prompt *"delegate to recipe peer-chatter with task 'list
/tmp'"* — the child spawns, runs in print mode, exits, and the
captured stdout comes back as the tool result.

For the **parent-driven approval** flow, drive `writer-foreman` end-
to-end (single file):

```sh
set -a; source models.env; set +a
mkdir -p /tmp/foreman-test
tmux new-session -d -s foreman -x 200 -y 50 \
  'AGENT_DEBUG=1 npm run agent -- writer-foreman --sandbox /tmp/foreman-test'
sleep 5
tmux send-keys -t foreman \
  'draft hello.txt with text "Hi"' Enter
sleep 90                              # delegate returns immediately (non-blocking),
                                      # child runs in background, foreman calls
                                      # approve_delegation({id, approved: true})
tmux capture-pane -t foreman -p       # expect "[deferred] writes applied: hello.txt"
ls /tmp/foreman-test/hello.txt        # file present with "Hi"
tmux send-keys -t foreman '/quit' Enter
```

For **parallel dispatch** (multiple files at once):

```sh
tmux send-keys -t foreman \
  'draft two files in parallel: hello.txt saying "Hi" and world.txt saying "World"' Enter
sleep 120   # foreman calls delegate twice (both children spawn in parallel),
            # then approve_delegation for each
ls /tmp/foreman-test/   # hello.txt and world.txt both present
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
