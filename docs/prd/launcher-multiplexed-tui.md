# Launcher-multiplexed TUI for human/mesh interaction

> Implements the architecture committed in [ADR-0004](../adr/0004-launcher-multiplexed-tui.md). This PRD is the full feature spec; the ADR is the architectural rationale.

## Problem Statement

Today a human running a **Mesh** participates as a **Peer** on the **Bus** via `human-relay.mjs` — a thin REPL that can `agent_send` messages to other peers and read its inbox. This works for one-off interactions but has three problems the operator feels directly:

1. **No mesh-level visibility.** The relay only shows what comes into its own inbox. There is no view of which peers are alive, what state they're in, what messages are flowing between *other* peers, or what decisions are pending up the supervisor chain.
2. **The human is on the bus, with all the leakage that implies.** Peers learn to address `human` by name; the relay is a fourth implementer of the bus envelope protocol; mesh-internal flows acquire "is the human listening?" semantics; the trust split between operator and participant blurs.
3. **No way to switch perspective.** The operator cannot follow what `worker-3` is actually doing without launching a separate terminal alongside the relay, and even then approval dialogs render somewhere unrelated to where the operator is looking.

The original framing — "humans don't run meshes directly; they run them under at least a `RABBIT_SAGE_MODEL` peer that is supervisor and human interface" — was a step toward fixing this, but conflated the supervisor role with the human's interface. Decoupling them while still giving the operator a single coherent view is the actual problem.

## Solution

Replace the human-as-peer relay with a **launcher-level TUI**. The launcher process owns the human's terminal and multiplexes the real pi TUIs of every peer: each peer runs interactive in its own PTY, and the launcher renders the **Focused Peer**'s buffer live in the main pane while keeping off-screen peers' buffers warm in the background. A right-rail chrome shows the peers list and a **Decisions Queue**.

The human drives the launcher via slash commands registered by a baseline `launcher-bridge` extension on every peer (`/focus <peer>`, `/pin`, `/tail`, `/decisions`). Approval and escalation prompts surface through pi's existing `ctx.ui.confirm` in whichever peer is focused — no second dialog system.

Two intercept triggers route decisions to the human:
- **Rule 1** — when the **Top Supervisor** picks `escalate` and there is no peer above, the rail surfaces the prompt via `ctx.ui.confirm` in the supervisor's own TUI; if the human isn't focused there, a "decisions pending in `<peer>`" badge appears in the chrome until they switch focus.
- **Rule 2** — when the human is the focused peer for X and X gets a `submission` / `approval-request`, the rail cancels X's LLM turn and surfaces the prompt via `ctx.ui.confirm` instead of `respond_to_request`.

Focus changes are a **hard cancel** on the previous focus (in-flight `ctx.ui.confirm` dismissed; original prompt re-injected to the LLM), unless the human pinned the decision — pinned decisions stay in the queue and never return to the LLM.

The launcher runs both `npm run agent <recipe>` (Seed Agent) and `npm run mesh <topology.yaml>` (Static Topology) — same TUI module, same human experience.

## User Stories

### Launching a mesh

1. As an operator, I want `npm run mesh -- <topology.yaml>` to launch every peer headlessly under a single launcher-owned terminal, so that I see one coherent TUI instead of a tangle of pi processes scattered across panes.
2. As an operator, I want `npm run agent -- <recipe>` to launch a single Seed Agent under the same TUI, so that organic mesh growth (via `mesh_spawn`) and pre-declared topologies feel identical from the keyboard.
3. As an operator, I want the launcher to print a loud warning at startup if the **Top Supervisor**'s tier resolves to `TASK_RABBIT_MODEL`, so that I notice when the escalation chain ends at a worker-tier model — without the launcher refusing to start, because the framework must stay modifiable for testing and demos.
4. As a topology author, I want to declare a required `entry: <peer>` field at the topology root, so that the launcher knows which peer to render first without making me guess at startup.
5. As a topology author, I want the validator to allow `entry` and the **Top Supervisor** to be different peers, so that I can launch focused on a worker for observation while the supervisor runs autonomously.
6. As a topology author, I want the validator to reject topologies with no `entry:` field, with two unset-`supervisor:` peers, with `@group` references to undefined groups, or with `acceptedFrom` / `peers` referencing names not in `nodes`, so that mistakes surface before any peer boots.
7. As an operator, I want the launcher to refuse to start when the bus root is already bound by another launcher instance, so that two operators don't accidentally collide on the same mesh.
8. As an operator, I want existing topologies with `type: relay` nodes to be rejected with a clear error pointing at the deprecation, so that I know to delete the node and update my workflow.

### Watching the mesh

9. As an operator, I want a right-rail peers list showing every peer in the mesh with a state icon (idle / thinking / running tool / awaiting / crashed), so that I have ambient awareness without having to switch focus.
10. As an operator, I want the peers list to mark the current **Focused Peer** distinctly (e.g. bold + arrow), so that I can see at a glance which peer my keyboard is wired to.
11. As an operator, I want crashed peers to remain visible in the list with a clear "crashed" indicator and exit code, so that I can debug the mesh without having to scroll back through stderr.
12. As an operator, I want the launcher to display mesh-level metadata (bus root, top supervisor name, peer count, uptime) somewhere unobtrusive, so that I can confirm I'm in the right mesh without rebooting.

### Switching focus

13. As an operator, I want to type `/focus <peer>` in the focused peer's input area to switch the launcher's focus, so that I can move the TUI between peers without leaving the keyboard.
14. As an operator, I want focus changes to be near-instant (the new peer's PTY buffer is already warm), so that the TUI feels responsive even mid-LLM-turn.
15. As an operator, I want the launcher to refuse to focus a peer that doesn't exist, with a clear error in the chrome, so that typos don't silently swap me to nowhere.
16. As an operator, I want `/focus` autocompletion against the live peer list, so that I don't have to remember exact instance names.
17. As an operator, I want focus to auto-shift to the **Top Supervisor** when the current focused peer crashes, with a clear "entry peer X exited; focus moved to <top>" notice, so that I'm never stranded with no input target.
18. As an operator, I want each peer's input to inject into that peer's pi session as a user-message (via stdin), so that talking to a peer through the TUI is indistinguishable from launching it standalone with `pi -p`.

### Intercepting decisions

19. As an operator focused on the **Top Supervisor**, I want every `submission` and `approval-request` it receives to surface as a `ctx.ui.confirm` dialog in the same pane I'm watching, so that I review decisions as the supervisor sees them — without launcher-owned dialog code.
20. As an operator focused on a worker that becomes a **submitTo** target mid-mesh, I want the same intercept behavior on that worker's inbound, so that focusing on any peer with the supervisor inbound rail loaded gives me the same level of control.
21. As an operator, I want intercept to **cancel** the LLM's pending turn (not run in parallel), so that there's no race between my pick and the LLM committing a different action.
22. As an operator, I want the dialog to offer the same four actions the LLM would (`approve`, `reject`, `revise`, `escalate`) plus a free-text `note:` field where applicable, so that I can choose `revise` and explain why without having to find another channel.
23. As an operator focused on the **Top Supervisor**, I want the `escalate` action to be greyed out, so that I don't accidentally send the dialog into a loop when there's no peer above.
24. As an operator focused on a peer with no supervisor inbound rail (a pure worker), I want intercept to be a silent no-op, so that focus on a worker only changes which session I see, not the worker's behavior.
25. As an operator, I want **Rule 1** (`escalate` from the **Top Supervisor** with no peer above) to surface the dialog via `ctx.ui.confirm` in the top supervisor's TUI even when I'm not focused there, plus a "decisions pending in `<peer>`" badge in the chrome, so that I notice the prompt without losing my current view.

### Pinning and the queue

26. As an operator, I want to type `/pin` while a `ctx.ui.confirm` dialog is open in the focused peer to promote that decision to the **Decisions Queue**, so that I can wander to other peers and come back without losing the prompt.
27. As an operator, I want pinned decisions to render in the right-rail Decisions Queue with the source peer name, decision kind (`submission` / `approval-request`), and a short summary of the artifact or note, so that I can scan pending items without having to open them.
28. As an operator, I want to type `/decisions` to jump focus into the queue and step through pinned items with arrow keys, picking an action for each, so that I can resolve a backlog of human-required decisions without playing whack-a-mole.
29. As an operator, I want shifting focus *away* from a non-pinned dialog to be a hard cancel — the dialog dismisses, the LLM gets a fresh turn on the original prompt — so that focus changes feel snappy and predictable.
30. As an operator, I want pinned decisions to survive focus changes, peer crashes (the original peer's process is fine; the queue belongs to the launcher), and the launcher's own restart, so that long-running review work isn't lost to incidental events.
31. As an operator, I want the queue to show a count badge in the chrome whenever non-empty, so that I always know there's outstanding human work even when the queue panel is collapsed.

### Bus tail

32. As an operator, I want to type `/tail` to toggle a bus-tail overlay showing every envelope flowing on the bus (sender, recipient, kind, short body), so that I can audit cross-peer traffic without needing structured logs.
33. As an operator, I want `/tail` to overlay rather than shrink the focused peer's pane, so that toggling it on doesn't reflow the pi TUI I'm watching.
34. As an operator, I want the bus tail to filter by envelope kind (`/tail submissions`, `/tail messages`), so that I can narrow to the traffic class I'm investigating.
35. As an operator, I want the bus tail to be capped at the last N envelopes (default 200) so that long-running meshes don't bloat the launcher's memory.

### Rendering fidelity

36. As an operator, I want the focused peer's pi TUI to render with full fidelity — `agent-header` strip, `agent-footer` four-line block, `deferred-confirm` dialog, extension-registered widgets — so that focus mode is indistinguishable from running that peer standalone.
37. As an operator, I want off-screen peers to keep rendering into their virtual buffers continuously, so that switching to them shows recent activity (not a blank screen waiting to redraw).
38. As an operator, I want resizing the launcher's terminal to propagate to every peer's PTY (so each peer's TUI lays out correctly when I focus it), so that the layout doesn't break after a window resize.

### Lifecycle

39. As an operator, I want the launcher to gracefully shut down every peer (SIGTERM, then SIGKILL after grace period) when I exit (Ctrl-C or `/quit`), so that no orphan pi processes are left bound to bus sockets.
40. As an operator, I want the launcher to handle individual peer crashes without bringing down the rest of the mesh, with a chrome notice and the focus auto-shift behavior from story 17, so that one buggy peer doesn't take the whole session with it.
41. As an extension author, I want a clean error path when the `launcher-bridge` extension can't reach `__launcher__.sock` (e.g. peer launched with `npm run pi` standalone), so that the extension fails gracefully rather than crashing pi at startup.
42. As an extension author, I want the `launcher-bridge` socket protocol documented as a typed envelope schema (mirroring `_lib/bus-envelope.ts`), so that I can write my own extensions that talk to the launcher without reverse-engineering the wire format.

### Modifiability

43. As a framework author, I want each in-peer baseline (`launcher-bridge`, `focus-state`, `slash-commands`, `intercept`, `bus-tail-emitter`) to be a separate extension with a single concern, so that I can disable, swap, or replace exactly one behavior without touching the others.
44. As a framework author, I want each launcher module (`pty-pool`, `virtual-buffer`, `multiplexer`, `chrome`, `launcher-socket`, `focus-controller`, `decisions-queue`, `topology-validator`, `entry-resolver`) to be a separate file with a single concern, so that the launcher follows the same per-axis decomposition as the existing rails.
45. As a framework author, I want testable cores extracted into `_lib/` modules (mirroring `_lib/supervisor-inbox.ts` from ADR-0003), so that each axis can be unit-tested without booting a real mesh.

## Implementation Decisions

### Architecture

- Locked into the architecture from [ADR-0004](../adr/0004-launcher-multiplexed-tui.md): humans are not peers; launcher multiplexes real pi TUIs; intercept reuses `ctx.ui.confirm`. This PRD does not relitigate that decision.
- Decomposition follows the per-axis split established by [ADR-0002](../adr/0002-habitat-materialises-once.md). No fat `launcher.ts`, no mega-extension.
- Two entry points (`npm run agent`, `npm run mesh`) share one TUI module. The TUI module itself is a small composition of the launcher modules listed below.

### In-peer baseline extensions

Five new pi extensions, auto-loaded by the launcher (not by `npm run pi` standalone). Each is a thin pi wrapper around a `_lib/` testable core where applicable.

- **`launcher-bridge`** — owns the connection to `${BUS_ROOT}/__launcher__.sock`. Exposes a typed API (`sendControl(envelope)`, `onSignal(handler)`) for sibling extensions. No business logic; the rest of the in-peer extensions consume this API rather than touching the socket directly.
- **`focus-state`** — tracks "am I currently the **Focused Peer**?" by listening to `focus` signals from the launcher via `launcher-bridge`. Exposes a `getFocusState() → boolean` getter that other rails read. Backed by `_lib/focus-state.ts`.
- **`slash-commands`** — registers `/focus`, `/pin`, `/tail`, `/decisions`. Each handler is a one-liner emitting one control envelope. New commands are added by appending one handler.
- **`intercept`** — decorates the supervisor inbound rail from `supervisor.ts`. Before the rail invokes `respond_to_request`, asks `focus-state.getFocusState()`. If focused, calls `ctx.ui.confirm` and routes the human's pick into an `approval-result` / `revision-requested` envelope as if it were the LLM's. Otherwise falls through to existing `supervisor.ts` behavior. Backed by `_lib/intercept.ts`. `supervisor.ts` is unchanged.
- **`bus-tail-emitter`** — when `focus-state` says focused AND the launcher requested tailing, forwards bus envelopes to the launcher socket as `tail-event` envelopes.

### Launcher modules

Nine launcher-side modules, written as TypeScript or `.mjs` files with the same single-axis discipline as pi extensions. Live under `scripts/launcher/` (or equivalent).

- **`pty-pool`** — spawns each peer via `node-pty` in interactive mode (no `--mode rpc`); manages PTY lifecycle (resize, kill, restart on entry-peer crash with `focus-controller` notification).
- **`virtual-buffer`** — per-peer wrapper over `xterm-headless`. Captures peer PTY output into an off-screen ANSI buffer; exposes `paint() → ansi` so `multiplexer` can render it. Backed by `_lib/virtual-buffer.ts`.
- **`multiplexer`** — owns the active-render loop. Reads the focused peer's `virtual-buffer`, paints it into the main pane region of the launcher's terminal. Re-paints on focus change, on PTY resize, on incoming PTY output for the focused peer.
- **`chrome`** — renders the right-rail (peers list, decisions queue, optional bus-tail overlay). Subscribes to `focus-controller`, `decisions-queue`, and `bus-tail` state; redraws on change. Pure rendering; no business logic.
- **`launcher-socket`** — binds `${BUS_ROOT}/__launcher__.sock`. Accepts incoming control envelopes from peers, dispatches to subscribers (`focus-controller` for focus changes, `decisions-queue` for pins, `chrome` for tail toggles). Same pattern as `agent-bus`'s socket server.
- **`focus-controller`** — focus state machine. Holds the current focused peer, fires `focus-changed` events to all peers via `launcher-socket`, handles auto-shift on entry-peer crash. Backed by `_lib/focus-controller.ts`.
- **`decisions-queue`** — pinned-decisions state. Receives `pin` control envelopes from peers; stores decision metadata (peer, kind, msg_id, summary, artifact preview); emits change events to `chrome`. Backed by `_lib/decisions-queue.ts`.
- **`topology-validator`** — validates topology YAML against the new schema (required `entry:`, exactly one peer with unset `supervisor:`, top-supervisor tier warning, no `type: relay` nodes, `@group` resolution). Returns `{errors, warnings}`. Backed by `_lib/topology-validator.ts`.
- **`entry-resolver`** — resolves the `entry:` field to a concrete peer name. Wired into `focus-controller` for crash auto-shift. Backed by `_lib/entry-resolver.ts`.

### Launcher↔peer wire protocol

A typed envelope schema mirroring `_lib/bus-envelope.ts`, defined in a new `_lib/launcher-envelope.ts`. Envelope kinds:

- **Peer → launcher:**
  - `focus-request { peer }` — `/focus` slash command result
  - `pin { msg_id }` — `/pin` slash command result
  - `tail-toggle { on, filter? }` — `/tail` slash command result
  - `tail-event { envelope }` — bus traffic forwarded by `bus-tail-emitter`
  - `decisions-jump {}` — `/decisions` slash command result
- **Launcher → peer:**
  - `focus-changed { focused: boolean }` — broadcast on every focus change to all peers
  - `tail-on { filter? }` / `tail-off {}` — sent to the focused peer to start/stop forwarding bus traffic
  - `pinned-resolved { msg_id, action, note? }` — sent back to the source peer when the human resolves a pinned decision

All envelopes carry `v: 1` for protocol versioning; mismatched versions are dropped with a stderr log.

### Topology schema additions

- New required root field: `entry: <peer-name>`. Validator rejects topologies missing it.
- `type: relay` nodes are no longer accepted. Validator rejects them with a deprecation pointer.
- Top-supervisor warning: emitted at startup if the lone unset-`supervisor:` peer's tier resolves to `TASK_RABBIT_MODEL`. Not a validation error.
- Existing fields (`groups`, `group_bindings`, `nodes`, peer-relationship fields) are unchanged.

### Migration

- `pi-sandbox/agents/mesh-authority.yaml` is renamed for clarity if its tier changes; otherwise it stays.
- `pi-sandbox/meshes/authority-mesh.yaml` and `pi-sandbox/meshes/grouped-mesh.yaml` get the `human` relay node deleted, an `entry: authority` line added, and `authority` becomes the explicit top supervisor.
- `scripts/human-relay.mjs` and `npm run mesh-human` are removed once the launcher TUI lands. AGENTS.md and CONTEXT.md references are updated.
- `scripts/launch-mesh.mjs`'s prefixed-output loop (today's primitive observability) is replaced by the launcher TUI; the launcher's invocation surface stays compatible with `npm run mesh -- <yaml>`.
- ADR-0001 and ADR-0003 footnotes get a "human-relay was retired by ADR-0004" tag.

## Testing Decisions

### What makes a good test in this codebase

Following the convention established by `_lib/supervisor-inbox.test.ts` and the unit-test contract in `AGENTS.md` ("hermetic by contract: no model API calls, no network, no env vars from `models.env`, no real filesystem outside the test's tmpdir"):

- Unit tests live alongside their source as `*.test.ts` and run under `vitest` via `npm test`.
- Tests verify external behavior of a deep module — observable inputs and outputs, not call-graph traces.
- No live model. No real bus socket. No real PTY. Tests use small in-memory fakes for everything outside the module under test.
- Property-style coverage where the input space is large (topology validator, focus state transitions); example-based coverage everywhere else.
- TUI-level integration testing remains a tmux-driven manual pattern (per AGENTS.md `### Unit tests` section); `npm test` does not boot the launcher.

### Modules with dedicated unit tests

All seven deep modules get a paired `*.test.ts`:

- **`_lib/focus-controller.test.ts`** — focus state machine. Coverage: setFocus/getFocus round-trip, focus-changed event emission, auto-shift on entry-peer crash (focus moves to top supervisor), refusing focus on non-existent peers, no-op when setting focus to already-focused peer.
- **`_lib/decisions-queue.test.ts`** — queue state. Coverage: enqueue/dismiss/list ordering, pin transitions a transient decision to sticky, dismiss removes from queue and emits change, count badge value derivation, queue survives focus-controller events (decoupling check).
- **`_lib/topology-validator.test.ts`** — YAML validation rules. Coverage: missing `entry:` rejected, multiple unset-`supervisor:` peers rejected, `type: relay` nodes rejected with deprecation message, `@group` references to undefined groups rejected, `acceptedFrom` / `peers` references to undeclared nodes rejected, top-supervisor tier warning emitted (not error) for `TASK_RABBIT_MODEL`, valid topologies pass cleanly.
- **`_lib/entry-resolver.test.ts`** — `entry:` field resolution. Coverage: explicit entry resolves to declared peer, entry differs from top supervisor allowed, missing-but-required entry caught (delegated from validator), crash-auto-shift returns top supervisor name.
- **`_lib/intercept.test.ts`** — supervisor inbound rail decision. Coverage: when focus-state is true, returns "human" (test the boolean decision; `ctx.ui.confirm` invocation is the wrapper extension's job and is integration-tested), when false returns "llm", `message`-kind envelopes always return "llm" regardless of focus, free-flow envelopes are unaffected.
- **`_lib/focus-state.test.ts`** — peer-side focus cache. Coverage: initial state defaults to false, `focus-changed { focused: true }` signal updates state, multiple updates last-write-wins, getter returns current value synchronously.
- **`_lib/virtual-buffer.test.ts`** — `xterm-headless` wrapper. Coverage: write/read round-trip preserves ANSI state, resize invalidates cached paint, paint output is deterministic for fixed input, multiple sequential writes accumulate. (Lighter coverage acceptable — most logic is in `xterm-headless`; we're testing the typed boundary.)

### Modules without dedicated unit tests

The seven shallow modules (`pty-pool`, `multiplexer`, `chrome`, `launcher-socket`, in-peer `launcher-bridge`, `slash-commands`, `bus-tail-emitter`) are integration- or smoke-tested only. Their logic is glue around heavier dependencies (`node-pty`, terminal rendering, Unix sockets, pi's slash command registry); a unit test would mostly mirror the dependency's own tests and lock us into implementation details.

### Prior art

- **`pi-sandbox/.pi/extensions/_lib/supervisor-inbox.test.ts`** — the reference for "extract testable core into `_lib/`, write a `*.test.ts` next to it, hermetic, no live pi." Every deep module test in this PRD follows the same shape.
- **`pi-sandbox/.pi/extensions/_lib/topology.mjs`** — existing topology-resolution module; the new `_lib/topology-validator.ts` builds on top of it. Their tests should compose, not duplicate.
- **AGENTS.md `### Verifying the multi-agent rails under tmux`** — pattern for live integration testing of TUI behavior. The launcher TUI's tmux integration tests follow the same shape: drive a real launcher under tmux, send keystrokes, capture-pane to verify rendering. Not part of `npm test`.

## Out of Scope

The following are deliberately deferred and should be tracked as separate issues, not folded into this PRD:

- **Multi-human collaboration.** One launcher, one human at the keyboard. No second operator can attach to a running mesh; no shared cursor; no conflict resolution. Designing this requires answering questions about peer-level auth and shared focus that would balloon the v1 surface.
- **Web-rendered or remote TUI.** This PRD is local-terminal-only. Rendering the launcher into a browser via `xterm.js`, exposing the launcher socket over SSH, or wrapping the TUI in a Tauri/Electron shell are all post-v1.
- **Persisted decision history / audit log.** The Decisions Queue is in-launcher-memory only. Pinned decisions survive focus changes but not launcher restart. A persistent audit log of who approved what, when, with which note is post-v1.
- **Replay or retroactive intercept.** The human cannot review and override decisions the LLM has already committed. Once `respond_to_request` ships, the action is final from the launcher's POV.
- **Mid-turn intercept by polling.** When focus shifts to a peer mid-LLM-turn, the rail cancels via SIGINT-equivalent and re-renders the prompt. There is no "watch the LLM think and override before it commits" race mode (we considered and rejected this in option (d) of the original Q6 discussion).
- **Custom chrome layouts beyond α-1 (right rail).** Top-strip and quadrant layouts (α-2, γ) are not implemented. Operators wanting different layouts swap `chrome.ts`.
- **TUI-driven mesh authoring.** No "create a peer interactively from the TUI" affordance. Mesh shape comes from topology YAML or `mesh_spawn` calls; the TUI observes and operates, not authors.
- **Reimplementing pi's TUI in the launcher** (option β from the design discussion). Rejected in ADR-0004; not revisited here.
- **Hard validator rejection of `TASK_RABBIT_MODEL` at top.** Warning only, by deliberate design choice (framework modifiability). A future ADR could revisit if the warning proves insufficient.

## Further Notes

### Risks worth surfacing

- **Pi slash-command latency during LLM turns.** From `command-recipe.md` slash commands are TUI-input-layer and should dispatch immediately, but this isn't verified against pi's source. If pi blocks slash-command processing during an active LLM turn, `/focus` while a peer is mid-turn would feel laggy. Fallback: an emergency keybinding (`Esc Esc` or similar) intercepted at the launcher level for "switch focus regardless of peer state." Decision deferred until we measure under real load.
- **PTY count scaling.** Every peer keeps a live PTY and `xterm-headless` instance, even when off-screen. For meshes with 20+ peers this could matter. Mitigation: virtual-buffer can be paused (stop draining PTY output until focused) for known-low-priority peers; a `paused: true` field on a topology node would express this. Out of scope for v1.
- **Terminal-resize fan-out.** When the launcher's terminal resizes, every peer's PTY needs the new dimensions. With 20+ peers this is 20+ `node-pty.resize` calls. Probably fine but worth measuring.
- **Recovery from launcher crash mid-mesh.** If the launcher crashes, every peer is orphaned (no one rendering them, no one binding `__launcher__.sock`). v1 behavior: peers exit when their PTY's parent dies. Future work: a "rejoin running mesh" mode where the launcher reconnects to existing peers via the bus root.

### Phasing suggestion (non-binding)

A natural phase order, mirroring the per-axis decomposition:

1. **Phase 1 — schema and validators.** `_lib/topology-validator`, `_lib/entry-resolver`, schema doc updates, deprecate `type: relay`. No runtime behavior change yet.
2. **Phase 2 — launcher socket and in-peer extensions.** `launcher-socket` + `launcher-bridge` + `focus-state`. Wire format finalised; peers can talk to a launcher even if the launcher is just a logger.
3. **Phase 3 — PTY pool and multiplexer.** `pty-pool` + `virtual-buffer` + `multiplexer` + a stub chrome. Manually focus a peer; render its TUI.
4. **Phase 4 — focus controller and slash commands.** `focus-controller` + `slash-commands` + `entry-resolver` integration + crash auto-shift. Operator can `/focus` between peers.
5. **Phase 5 — intercept rail.** `intercept` extension + decision routing. Focus-driven `ctx.ui.confirm` works.
6. **Phase 6 — decisions queue + pin.** `decisions-queue` + `/pin` slash command + chrome rendering. Sticky lifecycle.
7. **Phase 7 — bus tail.** `bus-tail-emitter` + `/tail` + chrome overlay.
8. **Phase 8 — `human-relay.mjs` removal and final cleanup.** Once all the above is solid, retire the old code path and update CONTEXT.md / AGENTS.md / ADR footnotes.

Each phase is independently testable and shippable; the mesh keeps working at every step.

### Related documents

- [ADR-0001 — Mesh subsumes delegation](../adr/0001-mesh-subsumes-delegation.md)
- [ADR-0002 — Habitat materialises once; rails read from a shared spec](../adr/0002-habitat-materialises-once.md)
- [ADR-0003 — Supervisor's LLM is in the review loop via `respond_to_request`](../adr/0003-supervisor-llm-in-review-loop.md)
- [ADR-0004 — Humans interact with meshes through a launcher-multiplexed TUI](../adr/0004-launcher-multiplexed-tui.md)
- [CONTEXT.md](../../CONTEXT.md) — domain glossary; entries for **TUI**, **Focused Peer**, **Intercept**, **Decisions Queue**, **Top Supervisor**.
- [AGENTS.md](../../AGENTS.md) — overall pi-agent recipe and rail conventions.




