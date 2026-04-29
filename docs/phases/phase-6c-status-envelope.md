# Phase 6c — status envelope + delegation-boxes rebuild

**Goal.** Add a `status` payload kind to the bus envelope so peers can report their state (model id, context %, cost, turn count, in-flight state) to interested observers. Build a status receiver and a TUI widget that surfaces inbound status as boxes above the input editor — replacing the `delegation-boxes` extension that was deleted in Phase 5 along with `agent-status-reporter`. Foundation for richer mesh observability.

**Behaviour after this phase:**
- Atomic-delegate workers emit status envelopes to their caller (`submitTo`); the caller's TUI shows live boxes for in-flight delegations.
- Long-running mesh peers (per static topology) emit status envelopes to their declared `submitTo`; that peer's TUI shows a box per active sender.
- Status flow uses standard bus dispatch — no new transport mechanism.
- Recipes that don't have anyone reporting to them see no boxes (silent baseline).

This file is deleted in the PR that ships Phase 6c.

---

## Prerequisite

All phases through Phase 5 merged to main. Recommended: **the tidies plan (`docs/phases/tidies.md`) merged first**. The tidies extract `_lib/bus-transport.ts` (item #5) and fix the supervisor `turn_end` dispatch latency (item #6) — both are cleaner foundations for 6c. If tidies haven't shipped, this plan still works but the implementer will have minor merge work and may find the supervisor's dispatch path harder to extend.

## Required reading

- `docs/adr/0001-mesh-subsumes-delegation.md` — the migration plan; this is the last architectural phase.
- `pi-sandbox/.pi/extensions/_lib/bus-envelope.ts` — payload union; you're adding a kind.
- `pi-sandbox/.pi/extensions/agent-bus.ts` — typed dispatch; status envelopes route here.
- `pi-sandbox/.pi/extensions/atomic-delegate.ts` — the dispatch-hook pattern (the new widget mirrors it).
- `pi-sandbox/.pi/extensions/_lib/atomic-delegate.ts` — for the worker name → registry mental model.
- The deleted `delegation-boxes.ts` and `agent-status-reporter.ts` from git history (`git show 4870f02^:pi-sandbox/.pi/extensions/delegation-boxes.ts`) — for reference of what the old widget rendered. **Don't port the implementation; use as a UX reference only.** The old version reached into `agent-spawn`'s globalThis registry that no longer exists.
- `pi-sandbox/.pi/extensions/_lib/context-bar.ts` — already exists for rendering an eighths-block bar; reuse it.
- `docs/phases/_notes-for-phase-3.md` and `_notes-for-phase-4.md` — remaining context.

## Skill

`/tdd`. Status envelope shape, the cache logic, and the rendering all have testable cores; keep `pi`-API code at the extension layer.

## Branch

Off latest `main` (or post-tidies main if those have shipped). Suggested: **`claude/phase-6c-status-envelope`**.

```sh
git fetch origin main
git checkout -b claude/phase-6c-status-envelope origin/main
npm test   # confirm baseline
```

## Scope — what's in (TDD order, per logical step)

### Step 1 — `status` payload kind in `_lib/bus-envelope.ts`

**Tests first** in `_lib/bus-envelope.test.ts`:

- `makeStatusEnvelope({from, to, agentName, modelId, contextPct, contextTokens, contextWindow, costUsd, turnCount, state})` produces an envelope with `payload.kind === "status"` and the fields populated.
- `tryDecodeEnvelope` accepts a well-formed status payload; rejects on missing required fields, wrong types, invalid `state` value.
- `renderInboundForUser` renders status as `[status from <peer>] <agentName> · turn N · $X.XX · <state>` (or similar).

**Then implementation:**

```ts
export type Payload =
  // ... existing kinds ...
  | { kind: "status";
      agentName: string;
      modelId: string;
      contextPct: number;
      contextTokens: number;
      contextWindow: number;
      costUsd: number;
      turnCount: number;
      state: "running" | "paused" | "settled" };
```

Add the constructor + extend `tryDecodeEnvelope` + extend `renderInboundForUser`. Pattern matches Phase 3a precisely.

### Step 2 — `_lib/status-cache.ts` (testable receiver core)

**Tests first** in `_lib/status-cache.test.ts`:

- `record(envelope)` stores the latest status keyed by `from`.
- `record` overwrites prior entry for the same `from`.
- `record` rejects non-status envelopes (returns false; doesn't store).
- `entries()` returns all current entries with timestamps.
- TTL eviction: entries older than `evictAfterMs` are dropped on `entries()` access (lazy eviction).
- `subscribe(callback)` fires the callback whenever `record` changes the cache; unsubscribe stops it.

**Then implementation:**

```ts
export interface StatusEntry {
  from: string;
  receivedAt: number;
  agentName: string;
  modelId: string;
  contextPct: number;
  contextTokens: number;
  contextWindow: number;
  costUsd: number;
  turnCount: number;
  state: "running" | "paused" | "settled";
}

export interface StatusCache {
  record(env: Envelope): boolean;
  entries(): StatusEntry[];
  subscribe(callback: () => void): () => void;
}

export function createStatusCache(opts?: { evictAfterMs?: number }): StatusCache;
```

Default TTL: 30 seconds. Settled entries persist for the same TTL so the user briefly sees the final state before the box disappears.

### Step 3 — `pi-sandbox/.pi/extensions/status-emitter.ts` (peer-side baseline)

A new baseline extension (added to `BASELINE_EXTENSIONS` in `run-agent.mjs`) that emits status envelopes when the peer has a `submitTo` configured.

Behaviour:
- Self-gates on `getHabitat().submitTo` — emits nothing if unset.
- Hooks `turn_start`, `turn_end`, `tool_execution_end`, `after_provider_response`, `agent_end` (mirrors the deleted `agent-status-reporter.ts`).
- Throttles emissions to one per 250 ms (mirrors the old throttle).
- Builds a status envelope using `_lib/bus-envelope`'s constructor and current session stats (`computeCost`, `countTurns`, `ctx.getContextUsage()`).
- Sends via `_lib/bus-transport.ts` `sendOverBus` (assumes tidies #5 has landed; otherwise call the bus's `sendEnvelope` directly or duplicate the socket-write inline as a transitional step).
- Best-effort: failures don't propagate; emission is non-fatal.

`session_start` validates the habitat has `submitTo`; if not, the extension is inert.

**Tests:** mock the sender; verify it's called with the expected envelope shape on each event hook; verify the throttle bound; verify settle-state on `agent_end`.

### Step 4 — receiver hook in `agent-bus.ts`

Add a globalThis dispatch hook (`__pi_status_dispatch__`) that runs after the existing pendingCalls / pendingSubmissions / atomic-delegate hooks but before the `acceptedFrom`-gated supervisor dispatch. When status envelopes arrive, the receiver hook records them in the cache.

The hook is registered by the new widget extension (Step 5) at `session_start`, just like the `__pi_atomic_delegate_dispatch__` and `__pi_supervisor_dispatch__` patterns. Returns true if the envelope was handled (so subsequent dispatch hooks don't run for status envelopes).

`acceptedFrom` enforcement question: should status envelopes from peers NOT in `acceptedFrom` be dropped? **Recommend: yes, drop them.** Status is observability, but a peer that I haven't authorised to send me anything shouldn't fill my widget either. Mirrors the supervisor rail's choice for `submission` and `approval-request` envelopes.

### Step 5 — `pi-sandbox/.pi/extensions/status-display.ts` (the widget)

A baseline extension that:
- Creates a `StatusCache` from `_lib/status-cache.ts`.
- Registers the dispatch hook from Step 4 — invokes `cache.record(env)` for incoming status envelopes.
- Sets up a TUI widget above the input editor (mirrors `delegation-boxes`'s `setWidget` pattern from `aboveEditor` placement).
- The widget's `render(width)` reads `cache.entries()` and produces boxes (one per active sender). Reuses `_lib/context-bar.ts`'s `renderBar` helper for the context-fill visual.
- Box layout: 2 boxes per row by default, 3 on terminals ≥ 120 columns wide (matches old delegation-boxes).
- `cache.subscribe(...)` calls `tui.requestRender()` so the widget redraws when new status arrives.

**Don't port the deleted `delegation-boxes.ts` verbatim.** Use it as a UX reference for the visual layout (4-line rounded-border boxes with name + model id + cost · turn · state · context bar) but build the implementation against the new `StatusCache` data source.

### Step 6 — atomic-delegate emits status during the in-flight call

Today's atomic-delegate spawns a worker, blocks on submission, returns the result. With Step 3 the worker emits status to its `submitTo` (which is the caller). The caller's status-display widget will show a box for the worker automatically once the dispatch hook is wired.

No code change needed in `atomic-delegate.ts` for status display to work — the wiring is implicit via Habitat (worker's `submitTo = callerName`) and the widget on the caller's side. Verify in tmux:

- Run writer-foreman → it spawns dutch-writer (or whatever instance name) → during the worker's drafting turn, a box appears in foreman's TUI showing `dutch-writer · turn 1 · $0.0001 · running`.
- When worker submits and exits, the box transitions to `settled` and stays for ~30s before evicting.

### Step 7 — runner registers the new baselines

In `scripts/run-agent.mjs`, add `status-emitter` and `status-display` to `BASELINE_EXTENSIONS`. Both self-gate (emitter on `submitTo`, display on having a TUI), so adding them doesn't change behaviour for recipes that don't need them.

### Step 8 — docs

Update `docs/agents.md` with a "Status reporting" section describing:
- The `status` envelope kind.
- How emission self-gates on `submitTo`.
- Where the widget renders.
- TTL eviction (30 s default).

## Scope — what's NOT in

- **No new tools.** Status is rail-level; no model-facing API.
- **No `delegation-boxes` extension reborn.** The new one is `status-display` — different name reflects the broader scope (it shows any peer's status, not just delegations).
- **No status pulled-on-demand.** Push-only via the `submitTo` field. A peer that doesn't have a configured `submitTo` (or whose `submitTo` peer's TUI isn't watching) emits nothing useful.
- **No persistence across sessions.** Status cache is in-memory; restart loses state.
- **No status from sealed peers.** Peers without `submitTo` configured don't emit. Sealed-by-default applies.
- **No status correlation with submissions.** A box shows a peer's *current* state; it doesn't tie back to the specific delegation/submission it's serving. Future enhancement, if useful.

## Step-by-step checklist

```
[ ]  1. Read prereqs (especially the deleted delegation-boxes for UX
        reference, plus the atomic-delegate dispatch-hook pattern).
[ ]  2. /tdd.
[ ]  3. Branch claude/phase-6c-status-envelope from main (post-tidies
        if those have shipped).

  STEP 1 — envelope kind:
[ ]  4. _lib/bus-envelope.test.ts: status constructor + decoder +
        renderer tests.
[ ]  5. _lib/bus-envelope.ts: extend Payload + constructor + decoder
        + renderer.

  STEP 2 — receiver core:
[ ]  6. _lib/status-cache.test.ts: record/entries/TTL/subscribe.
[ ]  7. _lib/status-cache.ts: implementation.

  STEP 3 — emitter extension:
[ ]  8. status-emitter tests (mock sender).
[ ]  9. pi-sandbox/.pi/extensions/status-emitter.ts: implementation.

  STEP 4 — bus dispatch hook:
[ ] 10. agent-bus.ts: register __pi_status_dispatch__ hook position;
        order: pendingCalls → pendingSubmissions → atomic-delegate
        → status → supervisor → inbox.

  STEP 5 — widget extension:
[ ] 11. pi-sandbox/.pi/extensions/status-display.ts: TUI widget +
        cache + dispatch hook registration.

  STEP 6 — runner baselines:
[ ] 12. scripts/run-agent.mjs: add status-emitter and status-display
        to BASELINE_EXTENSIONS.

  STEP 7 — docs:
[ ] 13. docs/agents.md: Status reporting section.

  VERIFICATION:
[ ] 14. npm test — green. Test count delta should be modest:
        + status-envelope tests (~5–8)
        + status-cache tests (~6–10)
        + status-emitter tests (~5–8)
[ ] 15. Tmux smoke: writer-foreman atomic delegate; confirm a status
        box appears for the worker during the in-flight call and
        transitions running → settled.
[ ] 16. Tmux smoke: a static topology (e.g. authority-mesh) where
        each worker peer has submitTo set; confirm authority's TUI
        shows boxes for the workers.

[ ] 17. Commit per logical step (8 commits).
[ ] 18. Push; delete this plan file.
```

## Acceptance criteria

- `_lib/bus-envelope.ts` has the status payload kind, constructor, decoder, renderer.
- `_lib/status-cache.ts` exists with TTL eviction and pub/sub.
- `status-emitter.ts` emits on event hooks when `submitTo` is configured.
- `status-display.ts` renders the widget; integrates with the cache.
- `agent-bus.ts` dispatch order updated; the new hook fires before `acceptedFrom`-gated supervisor dispatch but after pendingCalls / pendingSubmissions / atomic-delegate.
- Tmux smokes: atomic delegate shows a worker box; static topology shows worker boxes on the supervisor.
- `docs/agents.md` documents the status feature.
- This plan file deleted.

## What to do if you hit something unexpected

- **The widget API differs from what `delegation-boxes` used.** Pi may have evolved; consult `@mariozechner/pi-coding-agent` types or examples for the current widget contract. The deleted `delegation-boxes` is reference, not gospel.
- **`submitTo` is unset for a top-level user agent** — emitter is inert, no problem.
- **Multiple peers send status to the same `submitTo` with overlapping `from` names.** Shouldn't happen (instance names are unique), but if it does, last-write-wins via the cache's keying. Document if encountered.
- **`acceptedFrom` enforcement breaks unattended status emission.** If a peer's `submitTo` doesn't have `acceptedFrom` including the worker, status drops. This is by design — the supervisor's allowlist is authoritative — but worth flagging in the PR if it causes test setup pain.

## Hand-back

Push to `origin/claude/phase-6c-status-envelope`. Report:

- 8 commit SHAs.
- npm test output.
- Output of the two tmux smokes (atomic delegate + static topology).
- Whether the rebuilt widget visual matches the old `delegation-boxes` UX or differs (and why).
- Anything you found in the dispatch ordering that surprised you.

Don't open a PR.
