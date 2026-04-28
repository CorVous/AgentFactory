# Phase 3c — supervisor inbound rail + `respond_to_request` + relocate `requestHumanApproval`

**Goal.** Build the supervisor-side machinery. New rail extension catches inbound `submission` and `approval-request` envelopes from the bus, surfaces them to the supervisor's LLM, exposes a `respond_to_request({msg_id, action, note?})` tool with four actions (approve / reject / revise / escalate), routes the chosen action back over the bus. Move `requestHumanApproval` and `rpcRequestApproval` out of `deferred-confirm.ts` into a new shared module that owns the recursive escalation primitive.

**Behaviour after this phase: nothing currently emits `submission` or `approval-request` envelopes yet** (Phase 4 wires the worker side, Phase 5 wires atomic-delegate). So end-to-end exercise of this rail through real work doesn't happen until Phase 4. **3c is testable in isolation via synthetic envelopes** — vitest exercises the full request → respond → reply round-trip with mocked bus connections.

This file is deleted in the PR that ships Phase 3c.

---

## Prerequisite

Phase 3a + 3b merged to main. `npm test` works; `_lib/bus-envelope.ts` has the four new payload kinds; `_lib/habitat.ts` has `supervisor` / `submitTo` / `acceptedFrom` / `peers` fields.

## Required reading

- `docs/adr/0003-supervisor-llm-in-review-loop.md` — the **whole** rail design. Re-read until the four-action flow is clear.
- `docs/adr/0001-mesh-subsumes-delegation.md` — the migration plan.
- `docs/adr/0002-habitat-materialises-once.md` — the rail-reads-from-Habitat pattern.
- `docs/phases/_notes-for-phase-3.md` — **especially** the `agent_call` non-message-reply observation; this phase will hit it.
- `pi-sandbox/.pi/extensions/deferred-confirm.ts` — the file you're moving code *out of*.
- `pi-sandbox/.pi/extensions/agent-bus.ts` — the file you're modifying to dispatch new kinds.
- `pi-sandbox/.pi/extensions/_lib/bus-envelope.ts` (post-3a) and `_lib/habitat.ts` (post-3b) — what you're building on.

## Skill to invoke

`/tdd`. The escalation primitive and the action-routing logic are testable in isolation with mocked sockets/peers. Tests-first protects the move of `requestHumanApproval` (the most regression-prone part).

## Branch strategy

Branch from latest `main` (post-3a, post-3b). Suggested: `claude/phase-3c-supervisor-rail`.

```sh
git fetch origin main
git checkout -b claude/phase-3c-supervisor-rail origin/main
npm test   # confirm all prior phases' tests pass
```

## Scope — what's in (TDD order, per logical step)

### Step 1 — extract escalation primitive into `_lib/escalation.ts`

**Tests first** in `pi-sandbox/.pi/extensions/_lib/escalation.test.ts`:

- `requestHumanApproval(ctx, pi, req)` returns `ctx.ui.confirm(...)` result when `ctx.hasUI` is true.
- Returns `false` and writes loud-fail to stderr when `!ctx.hasUI` and `getHabitat().rpcSock` is unset / `getHabitat()` throws.
- When `getHabitat().rpcSock` is set, opens the socket, writes `{type: "request-approval", ...}` line, awaits `{type: "approval-result", approved}` reply. Mock the socket via `net.createServer` in the test.

**Then implementation:** copy the existing `requestHumanApproval` and `rpcRequestApproval` from `deferred-confirm.ts` into `_lib/escalation.ts` exactly. Update `deferred-confirm.ts` to import from there. The `_lib/escalation.ts` module becomes the canonical home for the recursive escalation primitive (per ADR-0001's "homeless primitive" framing).

### Step 2 — supervisor inbound rail

**Tests first** in `_lib/supervisor-inbox.test.ts` (or similar; the dispatcher logic may live in `_lib/` for testability):

- Inbound `approval-request` envelope from a peer in `getHabitat().acceptedFrom` is queued for handling.
- Inbound `approval-request` from a peer **not** in `acceptedFrom` is dropped silently (with stderr log under AGENT_DEBUG).
- Inbound `submission` from any peer is queued for handling. (`submitTo` is for the *outbound* direction; supervisors don't have a single allowed-submitter — they accept submissions from anyone in `acceptedFrom`.)
- After queue, the inbox handler calls `pi.sendUserMessage` with the rendered envelope.
- Per-action behavior (test each):
  - `approve` builds an `approval-result` envelope (`approved: true`) and sends to the original sender.
  - `reject` builds an `approval-result` (`approved: false`) and sends.
  - `revise` builds a `revision-requested` envelope (note required) and sends.
  - `escalate` builds a fresh `approval-request` for `getHabitat().supervisor` via `agent_call`. When that resolves, builds an `approval-result` mirroring the upstream answer back to the original sender.
- Loop guardrail: cap revision-cycle depth at 3 per `msg_id` chain; on cap, the rail forces approve / reject (no more revise allowed).

**Then implementation** in `pi-sandbox/.pi/extensions/supervisor.ts`:

- Registers the `respond_to_request` tool with schema:
  ```ts
  Type.Object({
    msg_id: Type.String(),
    action: Type.Union([
      Type.Literal("approve"),
      Type.Literal("reject"),
      Type.Literal("revise"),
      Type.Literal("escalate"),
    ]),
    note: Type.Optional(Type.String()),
  })
  ```
- Maintains a globalThis registry of pending inbound envelopes (mirrors the `__pi_*` idiom in `agent-bus.ts` / `deferred-confirm.ts`).
- Hooks `agent-bus`'s incoming dispatch (see Step 3) to queue envelopes by `msg_id`.
- On tool invocation, routes the action; the four actions delegate to internal handlers that build the appropriate reply envelope and `agent_send` it.

### Step 3 — agent-bus dispatch update

In `pi-sandbox/.pi/extensions/agent-bus.ts`'s `handleIncoming`:

- Add a typed dispatch on `env.payload.kind`:
  - `message` → existing inbox + pushToModel logic, unchanged.
  - `approval-request`, `submission` → forward to the supervisor rail's queue (via the globalThis registration the rail performs at session_start, mirroring the `__pi_*` idiom).
  - `approval-result`, `revision-requested` → if `env.in_reply_to` matches a `pendingCalls` entry, **resolve with the typed payload** (not just text). This is where the Phase 1 spot-check observation lands — the empty-string fallback gets replaced. **Recommended: reject the pending call's promise with a typed-mismatch error** if the caller used `agent_call` (which expects message-kind replies); the supervisor rail's escalation path uses its own internal correlation, not `agent_call`.
- Add `acceptedFrom` enforcement: before any non-message envelope is dispatched, check `env.from` against `getHabitat().acceptedFrom`. Drop with stderr log if not in the list. Message-kind envelopes still flow freely (existing peer chat is unrestricted by `acceptedFrom` for v1; tightening that is a separate decision).

### Step 4 — recipe schema + implicit-wire rule

In `scripts/run-agent.mjs`:

- When `recipe.acceptedFrom` is non-empty *or* `recipe.supervisor` / `recipe.submitTo` are set, auto-load the `supervisor` extension (similar to how `agents:` triggers `agent-spawn`).
- Auto-add `respond_to_request` to `tools` when the `supervisor` extension is loaded.
- Inverse rejection: if `recipe.extensions` explicitly includes `supervisor` but no relevant fields are set, `die()` with a clear message.

### Step 5 — documentation

- `docs/agents.md`: add a section describing the supervisor inbound rail, the `respond_to_request` tool, and the four-action flow. Reference ADR-0003.
- `pi-sandbox/.pi/extensions/supervisor.prompt.md`: model-facing tool documentation for `respond_to_request` (what each action does, when to use which).

## Scope — what's NOT in

- **No worker-side `submission` shipping.** Phase 4 builds that. Workers continue to apply their own drafts via `deferred-confirm` until Phase 4.
- **No atomic `delegate` rewrite.** Phase 5.
- **No topology YAML support.** Phase 6.
- **No deletion of `agent-spawn.ts` / `agent-status-reporter.ts`.** Phase 5.
- **No deletion of `Habitat.rpcSock`.** Bus path coexists with rpc-sock path until Phase 5 finishes the cutover.
- **No `acceptedFrom` enforcement on `message`-kind envelopes.** The peer-chat tightening is a separate decision; for now, only typed (non-message) inbound envelopes are gated by `acceptedFrom`. Pin as a follow-up question.

## Step-by-step checklist

```
[ ]  1. Read prereqs (especially ADR-0003 + notes file).
[ ]  2. /tdd.
[ ]  3. Branch claude/phase-3c-supervisor-rail from main.

  STEP 1 — escalation primitive:
[ ]  4. _lib/escalation.test.ts: tests for requestHumanApproval + rpc round-trip.
[ ]  5. _lib/escalation.ts: extract the two functions from deferred-confirm.
[ ]  6. deferred-confirm.ts: import from _lib/escalation.ts; drop inline.
[ ]  7. npm test — green.

  STEP 2 — supervisor rail:
[ ]  8. _lib/supervisor-inbox.test.ts: tests for queue + four-action routing.
[ ]  9. supervisor.ts extension: tool registration + action handlers + cap.
[ ] 10. npm test — green.

  STEP 3 — agent-bus dispatch:
[ ] 11. agent-bus.ts: typed handleIncoming dispatch + acceptedFrom check.
[ ] 12. agent-bus.ts pendingCalls: reject-on-typed-mismatch (resolves the
        Phase 1 forward-compat observation).
[ ] 13. npm test — green.

  STEP 4 — wiring:
[ ] 14. run-agent.mjs: implicit-wire rule + respond_to_request auto-tool +
        inverse rejection.

  STEP 5 — docs:
[ ] 15. docs/agents.md: append supervisor rail + respond_to_request docs.
[ ] 16. pi-sandbox/.pi/extensions/supervisor.prompt.md: model-facing tool docs.

  TESTING:
[ ] 17. npm test — all green (synthetic-envelope round-trips).
[ ] 18. Tmux smoke: existing three tests still pass (no observable
        behavior change yet — this rail is dormant until Phase 4 ships
        worker submissions).
[ ] 19. Tmux smoke (new): synthetic-submission test using a hand-crafted
        envelope sent from a test script to a supervisor-recipe agent.
        Verify the rail catches it, the model sees the prompt, the
        respond_to_request tool round-trips correctly. Document the
        test recipe in the PR.

[ ] 20. Commit per logical step (5 commits keeps reviewing tractable).
[ ] 21. Push.
[ ] 22. Delete this file in same PR.
```

## Testing

**Unit (vitest)** is the primary correctness proof since the worker side doesn't ship submissions yet. Aim for full coverage of the four-action routing, escalation chain, and `acceptedFrom` enforcement.

**Tmux integration** has two parts:
- Existing three tests (deferred-writer, peer-chatter, writer-foreman) must still pass — this phase shouldn't change observable behavior of any pre-3c flow.
- New synthetic-submission test: write a small recipe (e.g. `supervisor-test`) that loads `supervisor`, sets `acceptedFrom: [test-sender]`, and a small standalone Node script that sends a hand-crafted `submission` or `approval-request` envelope to the recipe's bus socket. Drive end-to-end through tmux to verify the rail catches it, surfaces it to the model, and routes the four actions correctly.

## Acceptance criteria

- `_lib/escalation.ts` exists; `deferred-confirm.ts` imports from it; behavior identical to pre-phase.
- `pi-sandbox/.pi/extensions/supervisor.ts` exists; registers `respond_to_request`; routes the four actions correctly; enforces the revision cap.
- `agent-bus.ts`'s `handleIncoming` dispatches by kind and enforces `acceptedFrom` for non-message envelopes.
- Pending `agent_call` entries reject with a typed-mismatch error when a non-message reply arrives (Phase 1 forward-compat observation now resolved).
- Implicit-wire rule fires when supervisor-related recipe fields are set; inverse rejection works.
- All three existing tmux tests still pass.
- New synthetic-submission tmux test exercises the four actions end-to-end.
- `docs/agents.md` and `supervisor.prompt.md` updated.
- This file (`docs/phases/phase-3c-supervisor-rail.md`) deleted in the same commit/PR.

## What to do if you hit something unexpected

- **`requestHumanApproval` has subtle behavior I didn't notice in the move.** That's why tests-first matters. If the move breaks the writer-foreman tmux test, the test you wrote in Step 1 was incomplete — extend it to cover the regression, fix the implementation, re-run.
- **Synthetic test recipe is hard to write because the supervisor rail expects an LLM response to its `respond_to_request` prompt.** Use a small mocked-LLM mode if pi supports it, or design the test to exit after the rail's queue is hit (verify the queue state, not the tool round-trip). Document the limitation.
- **`agent-bus.ts`'s `pendingCalls` reject-on-typed-mismatch breaks something.** That's a real possibility — current code resolves with `""` for any non-message reply. If anything depends on that empty-string behavior, the dependency is itself a bug; fix the dependency and continue.
- **The `acceptedFrom` enforcement breaks `peer-chatter`.** Shouldn't, since peer-chatter uses message-kind only. If it does, the `kind === "message"` carve-out in the enforcement check needs strengthening — every peer-chat code path should be unaffected.

## Hand-back

When the checklist is complete, push to `origin/claude/phase-3c-supervisor-rail` and report:

- Commit SHAs (one per logical step keeps reviewing tractable).
- Output of `npm test` (assertion count delta).
- Output of each tmux smoke test (existing three + new synthetic-submission).
- Anything noteworthy about the move of `requestHumanApproval` (e.g. discovered subtle invariants, edge cases in the escalation chain).
- Whether the synthetic-submission test had to mock the LLM response or whether you found a way to drive a real model end-to-end.

Don't open a PR.
