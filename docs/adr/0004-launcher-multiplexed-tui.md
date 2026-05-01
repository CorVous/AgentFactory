# Humans interact with meshes through a launcher-multiplexed TUI

The human is not a peer on the bus. A running mesh is launched and operated through a launcher-level **TUI** that multiplexes the real pi TUIs of every peer (each peer runs interactive in its own PTY; the **Focused Peer**'s PTY is rendered live, off-screen peers render to virtual buffers). Approval/escalation prompts surface in the focused peer's existing pi `ctx.ui.confirm`; intercept is just the rail picking the human path over the LLM path when its peer is focused. There is no `human-relay` peer.

## Why

- **Trust split.** The human is the operator, not a participant. Modeling them as a peer (`human-relay.mjs`) leaks that role onto the bus — peers learn to address `human` by name, the bus protocol acquires "is the human listening?" semantics, and the relay process drifts as a fourth implementer of the envelope protocol (the same drift ADR-0001 called out for `agent-spawn`). Putting the human at the launcher boundary keeps peer-to-peer wire semantics untainted.
- **Intercept reuses pi's own UI.** Pi already renders confirmation dialogs cleanly via `ctx.ui.confirm`. If the focused peer's PTY is alive and rendered, the rail just calls `ctx.ui.confirm` when it would otherwise call `respond_to_request`; the dialog appears in the same pane the human is already watching. No second dialog system to build, no double-render of the same prompt across launcher chrome and pi's own surface.
- **TUI mobility is a first-class affordance.** "Switch focus to peer X" is a real operator need (debugging a worker mid-run, observing an analyst's reasoning, hand-driving a supervisor). With each peer running its own full pi TUI, mobility is just selecting which buffer to render; the unfocused peers keep working. A launcher-reimplemented renderer would have to chase pi's rendering on every release.
- **One human surface across both entry points.** `npm run agent` (Seed Agent) and `npm run mesh` (Static Topology) share the same TUI module — the human's experience is identical regardless of how the mesh was launched.

## Considered alternatives

- **Human-as-peer relay (current).** Rejected: the human's keystrokes and the relay's bus envelopes are the same flow expressed twice; peer protocol grows special cases for "the human peer"; the relay process is a parallel re-implementation of `bus-envelope` that has to be kept in sync (already flagged in ADR-0001). Adding mesh-status views on top of that model would deepen the homelessness, not fix it.
- **Launcher-reimplemented TUI** — peers run `--mode rpc`, the launcher consumes structured events and renders them in launcher-owned components matching pi's look. Rejected: every pi rendering improvement (new event types, agent-header changes, deferred-confirm dialog tweaks) becomes a porting task; intercept dialogs need separate code paths from pi's own `ctx.ui.confirm`; off-screen peers still need *some* renderer running to keep their state coherent. The fidelity gap compounds.
- **Hybrid: focused peer interactive, others headless.** Rejected: pi cannot switch between TUI and `--mode rpc` mid-process. Restarting a peer to give it a TUI when focused would lose its in-memory state (LLM context, deferred-write queue, in-flight delegate Promise).

## Consequences

- **Top Supervisor recommended tier ≥ `LEAD_HARE_MODEL`.** With the human off the bus, the escalation chain ends at an LLM; letting that LLM be a Task Rabbit means the cheapest model is the final approver. The launcher prints a loud warning at startup (`WARNING: top supervisor '<peer>' resolves to TASK_RABBIT_MODEL — escalation chain will end at a worker-tier LLM`) but does **not** reject the topology. Keeping the framework modifiable for testing, demos, and deliberate overrides outranks enforcing the trust-split rule by validator. Recipe authors and topology reviewers carry the discipline; the framework just nudges.
- **`human-relay.mjs` and `type: relay` topology nodes are deprecated** and will be removed once the launcher TUI lands. Existing topologies (`authority-mesh.yaml`, `grouped-mesh.yaml`) get the `human` node deleted and `authority` becomes the explicit top supervisor.
- **Topology schema gains a required `entry: <peer>` field** at the root. Names the peer the TUI starts focused on. May or may not equal the top supervisor; the validator allows either. On entry-peer crash, focus auto-shifts to the top supervisor.
- **A small group of baseline extensions on every peer** mediates the human surface (see *Decomposition* below). Auto-loaded by the launcher; not loaded by raw `npm run pi`.
- **Launcher binds `${BUS_ROOT}/__launcher__.sock`** for two flows: peer→launcher control envelopes (focus/pin/tail) and `escalate`-from-top-supervisor raise-to-human routing. This is the single human-facing socket; it lives outside any peer's `acceptedFrom` because the human is not a peer.
- **PTY multiplexing infrastructure** (`node-pty` + a virtual-terminal buffer like `xterm-headless`) is added to the launcher. Every peer's PTY renders into a buffer; the launcher swaps which buffer paints the focused pane on focus change.
- **Focus-change is a hard cancel on the previous focus** (CONTEXT.md: Intercept). In-flight `ctx.ui.confirm` dialogs are dismissed and the original prompt is re-injected to the LLM as a fresh `respond_to_request` turn. **Pin** is the explicit override — pinned decisions survive focus shifts and never return to the LLM.
- **Two intercept triggers** (CONTEXT.md: Intercept, Decisions Queue) — focus + inbound `submission`/`approval-request` on the focused peer; `escalate` from the top supervisor when no peer remains above. Both render through `ctx.ui.confirm`; the second leaves a "decisions pending in `<peer>`" badge in the launcher chrome until the human switches focus to answer.
- **`escalate` action is greyed out in the TUI when focus is on the top supervisor** — there is no peer above; allowing it would loop straight back to the same dialog.

## Decomposition

The new infrastructure follows the same per-axis split that ADR-0002 established for the Habitat: each behavior is its own extension or module, swappable in isolation. Nothing here is a fat `launcher.ts` or a single mega-extension — that would conflate "what is the human surface" with "how each piece of it is enforced," and changes to one axis would force edits to others.

**In-peer baseline extensions** (auto-loaded for peers launched under the launcher; not loaded by `npm run pi`):

| Extension | Single concern |
|-----------|----------------|
| `launcher-bridge` | Socket plumbing to `${BUS_ROOT}/__launcher__.sock` only. Exposes a typed API for sibling extensions to emit control envelopes and subscribe to launcher signals. Nothing about focus, intercept, or commands. |
| `focus-state` | Tracks "am I currently the Focused Peer?" by listening to launcher signals. Exposes a `getFocusState()` getter that other rails read. |
| `slash-commands` | Registers `/focus`, `/pin`, `/tail`, `/decisions`. Each handler is a one-liner that emits a control envelope via `launcher-bridge`. New commands = one new handler in this file. |
| `intercept` | Decorates the inbound rail from `supervisor.ts`. When `focus-state` says focused, picks `ctx.ui.confirm` over the LLM's `respond_to_request`; otherwise falls through. `supervisor.ts` itself is unmodified. |
| `bus-tail-emitter` | When focused and `/tail` is on, forwards bus envelopes to the launcher for the bus-tail overlay. |

**Launcher modules** (separate files in `scripts/launcher/` or similar — node, not pi extensions, but the same discipline):

| Module | Single concern |
|--------|----------------|
| `pty-pool` | Spawns peers via `node-pty`; PTY lifecycle. |
| `virtual-buffer` | Per-peer `xterm-headless` wrapper; captures peer output into a renderable buffer. |
| `multiplexer` | Renders one buffer to the real terminal; redraws on focus change. |
| `chrome` | Right-rail rendering (peers list, decisions queue) on top of the multiplexed buffer. |
| `launcher-socket` | Binds `__launcher__.sock`; dispatches incoming envelopes to subscribers. |
| `focus-controller` | Focus state machine; emits signals to peers; auto-shift on entry-peer crash. |
| `decisions-queue` | Pending-decisions state; pin/dismiss; renders into `chrome`. |
| `topology-validator` | YAML schema validation; emits the top-supervisor warning. |
| `entry-resolver` | Resolves the topology `entry:` field; integrates with `focus-controller` for crash auto-shift. |

The discipline is not free — more files, more interface boundaries, slightly more ceremony per change. The trade-off is "if a future you wants to replace exactly one behavior, can you do it without touching anything else?" The repo's existing rail pattern says yes; this infrastructure inherits that contract.

## Amendment (2026-05-01) — Mesh status surfaces inside pi's TUI (issue #88)

The original *Consequences* described *"Launcher chrome (peers list, Decisions Queue) lives in a right rail"* rendered by the launcher to stderr alongside the focused peer's stdout. Slice 2's first attempt — buffer-paint the focused peer on every PTY chunk — produced unusable rendering: full-screen reprint per keystroke, stripped SGR, wrong cursor (issue #88). Refactoring slice 2 to "paint-once-on-focus-change with pass-through between" (the literal reading of *"swaps which buffer paints the focused pane on focus change"*) re-opens a different problem the original ADR didn't address: chrome's stderr writes interleaving with pi's stdout would strand the cursor mid-keystroke during pi's live editing.

This amendment relocates the rail into pi rather than continuing to fight the interleaving. The same logic that argued *"Intercept reuses pi's own UI ... no double-render of the same prompt across launcher chrome and pi's own surface"* applies to mesh status.

### Rendering pipeline

- **Focused peer**: PTY output passes through verbatim to the launcher's stdout. The peer's `xterm-headless` virtual buffer continues to accumulate so focus changes have something to paint.
- **Off-screen peers**: write only to their virtual buffer (unchanged from slice 3).
- **Focus change**: the multiplexer paints the destination peer's accumulated buffer once (with SGR reconstruction and cursor restore), then resumes pass-through. The snapshot's role is narrow — make the few hundred ms before pi's next render look right; the bar for SGR fidelity is bounded.

### Mesh status surface

- A new in-peer baseline extension `mesh-rail` (auto-loaded under the launcher) renders mesh status as a `nonCapturing` overlay anchored `top-right`, sized `width: "30%"` with bounded `maxHeight`, via `ctx.ui.custom({ overlay: true, overlayOptions: { ... nonCapturing: true } })`. Pi's overlay system composites the rail into the focused peer's TUI; the launcher emits no chrome of its own.
- Slash command `/decisions` opens a rich centered overlay (focus-capturing) for full peer detail and pin/dismiss affordances. The `mesh-rail` overlay hides while it is open via `OverlayHandle.setHidden(true)` and reappears on close. Other overlays (intercept's `ctx.ui.confirm`, future `/peers`) leave the rail stacked — the rail's ambient mesh-state context remains useful while the human picks an intercept action.
- `mesh-rail` subscribes to launcher signals via the existing `launcher-bridge` extension. The launcher's `decisions-queue.mjs` and `focus-controller.mjs` modules continue to own state but stop holding render code; they broadcast renderable summaries to peers instead.
- `scripts/_lib/chrome.mjs` and its tests are removed. `launch-mesh.mjs` stops writing peer-state chrome to stderr.

### Decomposition diff

- **Add to in-peer baseline extensions:** `mesh-rail` — *Renders the mesh-status overlay (peers list, decisions count) and exposes a hide/show handle for slash-command handlers. Subscribes to launcher signals via `launcher-bridge`.*
- **Remove from launcher modules:** `chrome` (deleted).
- **Amend `decisions-queue` row:** *Pending-decisions state; pin/dismiss; broadcasts renderable summaries to `mesh-rail` peers* (no longer renders into `chrome`).

### Trade-offs accepted

- **Chat lines wider than `termWidth - rail_width` clip in the rail's row range** (top-right corner only). Pi's overlay compositor floats; it does not reflow base content (`pi-tui/dist/tui.js:611` — `compositeLineAt` splices the overlay column-range into the base line). The editor and footer sit outside the rail's row range (rail's `maxHeight` is bounded so it never extends down into them) and are unaffected. The latest visible chat (where the human is looking) sits below the rail; only the oldest visible lines on the right are at risk.
- A follow-up tracks an upstream pi-tui PR for `TUI.setReservedRight(cols)` which would let base components render at `(termWidth - reservedRight)` while overlays still composite in full-`termWidth` coordinates. When that lands, clipping disappears with no other change in this repo. Until then this is acknowledged-cosmetic.
