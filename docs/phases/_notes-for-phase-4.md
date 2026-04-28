# Notes for Phase 4 plan

Scratch file — observations from Phase 3c's spot-check that Phase 4's planner needs to see. Delete this file when Phase 4 plan is written; contents fold into the plan's "Inherited state" / "Out of scope" / "Tidy in passing" sections.

This file is **not a plan**. It's a memo for the plan author.

---

## What's already in main from Phase 3c

The supervisor inbound rail is **built but dormant.** Phase 4's job is to wake it up by making workers emit `submission` envelopes. Specifically, on main now:

- `_lib/escalation.ts` owns `requestHumanApproval` and `rpcRequestApproval`. `deferred-confirm.ts` is a thin user; the recursive escalation primitive has its proper home.
- `pi-sandbox/.pi/extensions/supervisor.ts` registers the `respond_to_request` tool and forwards inbound `submission`/`approval-request` envelopes to its testable core in `_lib/supervisor-inbox.ts`.
- `_lib/supervisor-inbox.ts` exposes `createSupervisorInbox()` with the four-action graph (approve/reject/revise/escalate), revision cap (3), `acceptedFrom` enforcement.
- `agent-bus.ts` does typed dispatch on `payload.kind`. Non-message replies to pending `agent_call`s now reject with typed-mismatch errors (Phase 1 forward-compat issue resolved).
- Implicit-wire rule: any of `acceptedFrom` / `supervisor` / `submitTo` set on a recipe → `supervisor` extension auto-loads + `respond_to_request` auto-added to tools.

## Things to wire on the worker side (Phase 4's main work)

When `getHabitat().submitTo` is set, the `deferred-*` extensions' `apply()` step should change behavior:

- Today (and through Phase 3c): `apply()` writes to disk in the worker's own scratch / canonical sandbox.
- Phase 4: when `submitTo` is set, `apply()` should *package* the staged operations as artifacts and ship a `submission` envelope to the `submitTo` peer, then **wait for the reply** (an `approval-result` envelope referencing the submission's `msg_id`).

The artifact builders need to compute the SHA-256 receipts the supervisor's apply path will check:

- `write` artifact: `sha256` of the new content.
- `edit` artifact: `sha256OfOriginal` of the file as the worker read it.
- `move` artifact: `sha256OfSource` of the source file as the worker read it.
- `delete` artifact: `sha256` of the file as the worker read it.

The supervisor side hasn't been built yet (Phase 4 also adds the apply path on the supervisor end). Plan order: (1) worker emits submission; (2) supervisor's `respond_to_request({action: "approve"})` calls a new "apply submission" path that mirrors today's deferred-confirm `apply()` against the supervisor's *canonical* sandbox.

## Tidy in passing (small follow-ups Phase 3c spot-check flagged)

Phase 4 is going to touch most of these files anyway, so the cleanups can ride along:

### 1. `escalateViaBus` reimplements envelope decoding

Location: `pi-sandbox/.pi/extensions/supervisor.ts` (the `escalateViaBus` function). The reply parsing does `JSON.parse(line)` + manual shape check on `raw?.payload?.kind === "approval-result"`.

Replace with `tryDecodeEnvelope(line)` from `_lib/bus-envelope`. Same correctness, one source of truth for decoding. A future envelope change (checksum, version bump) shouldn't have to update this file separately.

### 2. Dead code: `getPendingRegistry()` in supervisor-inbox

Location: `pi-sandbox/.pi/extensions/_lib/supervisor-inbox.ts`. The `getPendingRegistry()` function reads a globalThis-stashed Map but `createSupervisorInbox()` uses its own closure-local `pending` Map. The globalThis path is unused.

Likely leftover from an earlier design iteration. Delete the function (and the `__pi_supervisor_pending__` global it references) unless Phase 4 finds a real use for it.

### 3. `updatePendingMsgId` needs to be wired

Location: `pi-sandbox/.pi/extensions/_lib/supervisor-inbox.ts`. Exported but unused.

This is forward-compat for **revision threading**: when a worker's submission gets a `revision-requested` reply, the worker re-submits as a new envelope with `in_reply_to` pointing to the *original* `msg_id`. The supervisor needs to recognise the new submission as a continuation of the original thread (same revision counter, same root msg_id) rather than a fresh inbound.

Phase 4's worker side will create the linkage; the supervisor side needs to use `updatePendingMsgId` (or similar) when an inbound `submission` arrives whose `in_reply_to` matches a pending entry that was previously sent a `revision-requested` reply.

Concretely the supervisor's `dispatchEnvelope` flow needs an "is this a revision continuation?" branch that calls `updatePendingMsgId` instead of creating a new pending entry.

## Submission → approval-request transformation in `escalate` loses artifact details

Location: `_lib/supervisor-inbox.ts`'s `escalate` action.

When a supervisor receives a `submission` and chooses to `escalate`, the rail forwards an `approval-request` upstream — the upstream sees `{title, summary, preview}` (rendered text), not the actual artifacts. If the upstream approves, the *original* supervisor applies the artifacts (still in its pending entry).

This is correct for v1 because the `submission` can't be cleanly forwarded (the upstream isn't the `submitTo` for the worker, and the `submitTo` field is per-edge not per-chain). But it should be **documented** in `supervisor.prompt.md` so a supervisor LLM that's about to `escalate` understands the upstream sees only the rendered preview, and any artifact detail it wants the upstream to consider should be summarised in the original `submission`'s `summary`/`preview` fields by the worker, or surfaced by the supervisor in the `escalate` action's `note`.

Phase 4 should add this paragraph to `supervisor.prompt.md`.

## Synthetic-submission tmux test from Phase 3c was deferred

The Phase 3c plan asked for a synthetic-submission tmux test (a Node script sending a hand-crafted submission envelope to a supervisor recipe's bus socket). The implementing session deferred it as a manual step, citing that unit tests cover the action graph and real end-to-end will land in Phase 4.

**Phase 4 absorbs this test as part of its own integration testing.** Once workers emit submissions, the natural test is `worker-recipe → submitTo: supervisor-recipe → respond_to_request`. The synthetic-script approach becomes unnecessary because real workers replace the script.

The Phase 4 tmux smoke tests should cover:
- A worker (`deferred-writer` with `submitTo: supervisor-test` set) emits a submission; supervisor receives, approves, applies to canonical.
- Same flow with `revise` action; worker re-submits; second-round approval applies.
- Same flow with `reject`; nothing applies; worker logs the rejection.
- Same flow with `escalate` (requires a three-peer mesh); upstream supervisor approves; original supervisor applies.

## Inbound dispatch latency (turn_end delay)

Location: `pi-sandbox/.pi/extensions/supervisor.ts`. Current flow:

1. agent-bus's `handleIncoming` calls `__pi_supervisor_dispatch__`.
2. supervisor's dispatch pushes the rendered text to a queue (`__pi_supervisor_pending_msgs__` on globalThis).
3. supervisor's own `turn_end` handler drains and calls `pi.sendUserMessage`.

The two-handler queue exists because the dispatch entry point doesn't have a `pi` reference (it's called from agent-bus.ts). The result: an inbound envelope arriving mid-turn isn't surfaced to the supervisor's model until the *next* `turn_end`.

Phase 4 doesn't need to fix this — it works correctly. But if Phase 4's testing reveals annoying latency in the worker → supervisor → reply round-trip, the simplest fix is for `supervisor.ts` to capture its own `pi` reference at `session_start` and pass it directly to `dispatchToSupervisor` via a closure (instead of bouncing through globalThis), letting the supervisor's `turn_end` handler be removed.

Pin as a v2 follow-up unless it actively bites.
