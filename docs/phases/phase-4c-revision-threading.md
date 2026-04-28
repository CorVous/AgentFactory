# Phase 4c — revision threading

**Goal.** Wire the worker side of the revise action so the model can iterate. When `dispatchSubmissionReply` resolves with `revisionNote` (Phase 4a's placeholder logged-and-discarded), instead surface the note to the worker's model as a synthetic user prompt and let the model re-emit modified `deferred_*` calls on its next turn. On the supervisor side, recognise re-submissions whose `in_reply_to` matches a pending entry as continuations of the original thread (using the previously-exposed but unwired `updatePendingMsgId`).

**Behaviour after this phase:**
- A worker that gets `revision-requested` retains thread context and re-emits a new submission with `in_reply_to` linking back to the original.
- The supervisor's pending registry tracks the revision count per thread; the cap (3) already in `_lib/supervisor-inbox.ts` enforces.
- Workers that get `approval-result {approved: true | false}` continue to behave exactly as in Phase 4a.
- Recipes that don't set `submitTo` are entirely unaffected.

This file is deleted in the PR that ships Phase 4c.

---

## Prerequisite

All of Phase 4 (4a + 4b) merged to main. `npm test` works. The `revision-requested` envelope kind exists in `_lib/bus-envelope.ts` (Phase 3a). `_lib/supervisor-inbox.ts` exposes `updatePendingMsgId` (Phase 3c) but it's unused.

## Required reading

- `pi-sandbox/.pi/extensions/_lib/submission-emit.ts` — see how `dispatchSubmissionReply` separates `approval-result` from `revision-requested` and how `shipSubmission` resolves with `revisionNote` for the latter.
- `pi-sandbox/.pi/extensions/deferred-confirm.ts` — the `submitTo` branch in `agent_end` that currently logs+discards on `revisionNote`.
- `pi-sandbox/.pi/extensions/_lib/supervisor-inbox.ts` — the `dispatchEnvelope` flow that creates pending entries; the `updatePendingMsgId` method exists but no caller invokes it; the `revisionCount` and `rootMsgId` fields on `PendingEntry`.
- `docs/adr/0003-supervisor-llm-in-review-loop.md` — revise semantics and the cap.

## Skill

`/tdd`. Both sides have testable cores; supervisor side already has dependency-injected sender callbacks for clean unit tests.

## Branch

Off latest `main`. Suggested: **`claude/phase-4c-revision-threading`**.

```sh
git fetch origin main
git checkout -b claude/phase-4c-revision-threading origin/main
npm test   # confirm baseline
```

## Scope — what's in (TDD order)

### Step 1 — Worker side: re-prompt instead of discard

**Tests first** (extend `_lib/submission-emit.test.ts` or add a new test file for the deferred-confirm fork). Cover:

- When `shipSubmission` resolves with `{approved: false, revisionNote: "X"}`, the worker's deferred-confirm fork calls `pi.sendUserMessage` with a string containing `"X"` and the original `msg_id` prefix.
- The worker's deferred-* queues are NOT re-populated (they were cleared by `prepare()` already; the model re-emits via tool calls on next turn).
- The worker's deferred-confirm fork records the original `msg_id` so the next submission can link to it via `in_reply_to`.

**Then implementation** in `pi-sandbox/.pi/extensions/deferred-confirm.ts`:

The current revise branch:
```ts
} else if (reply.revisionNote !== undefined) {
  tell(ctx, "info", `submission revision requested (treating as reject): ${reply.revisionNote}`);
}
```

Replace with:
```ts
} else if (reply.revisionNote !== undefined) {
  // Surface the revise note to the model so it can re-emit modified deferred_*
  // calls on next turn. The new submission will link to the original via
  // in_reply_to so the supervisor can track this as the same thread.
  storeLastSubmissionMsgId(env.msg_id);   // see Step 2
  pi.sendUserMessage(
    `[supervisor revise re:${env.msg_id.slice(0, 8)}] ${reply.revisionNote}`,
    { deliverAs: "followUp" },
  );
  tell(ctx, "info", `revision requested: ${reply.revisionNote}`);
}
```

Note: the variable `env` here is the *outbound submission envelope* — `shipSubmission` doesn't currently expose it. Adjust `shipSubmission`'s return shape to include the original `msg_id` (or have it return `{approved, note?, revisionNote?, originalMsgId?}` — minor API change).

### Step 2 — Worker side: thread the next submission

When the worker re-emits via `deferred_*` tool calls and reaches `agent_end` again, the next `shipSubmission` should set `in_reply_to` to the original submission's `msg_id`. This requires:

- A small per-session store of "the last submission msg_id awaiting revision continuation." Stash on globalThis (mirroring `__pi_pending_submissions__`).
- `deferred-confirm.ts`'s `submitTo` branch reads this when constructing the next submission and passes it through `shipSubmission` (which already accepts an `in_reply_to` field via `makeSubmissionEnvelope`).

```ts
// in _lib/submission-emit.ts (or a new tiny _lib/submission-thread.ts):
export function storeLastSubmissionMsgId(id: string): void;
export function takeLastSubmissionMsgId(): string | undefined;  // consumes it
```

The store is consumed (taken once) by the next submission, so a worker that gets a successful approval (or hits the revision cap) doesn't accidentally link a future fresh task back to an old thread.

### Step 3 — Supervisor side: detect revision continuations

**Tests first** in `_lib/supervisor-inbox.test.ts`:

- Inbound `submission` whose `in_reply_to` matches a pending entry's `msg_id` → existing entry is updated via `updatePendingMsgId` (msg_id swapped, `revisionCount` carried, `rootMsgId` preserved).
- Inbound `submission` with `in_reply_to` pointing to a missing/cleaned-up entry → treated as a fresh submission (existing behaviour; no error).
- The model receives a prompt indicating this is a revision (e.g. `[submission from <peer> re:<id>] (revision N) <summary>`).

**Then implementation** in `_lib/supervisor-inbox.ts`'s `dispatchEnvelope`:

```ts
dispatchEnvelope(env, sendMessage) {
  const kind = env.payload.kind;
  if (kind !== "approval-request" && kind !== "submission") return;
  if (!isAllowed(env.from)) { /* drop, existing */ return; }

  // NEW: if this is a revision continuation, update the existing entry.
  if (kind === "submission" && env.in_reply_to) {
    const existing = pending.get(env.in_reply_to);
    if (existing) {
      const updated: PendingEntry = {
        env,
        revisionCount: existing.revisionCount,  // already incremented at revise-time
        rootMsgId: existing.rootMsgId,
      };
      pending.delete(env.in_reply_to);
      pending.set(env.msg_id, updated);
      const rendered = renderInboundForUser(env);
      const hint = `\n[revision ${existing.revisionCount}] respond_to_request({msg_id: "${env.msg_id}", action: ...})`;
      sendMessage(env.msg_id, rendered + hint);
      return;
    }
  }

  // Existing fresh-submission path.
  pending.set(env.msg_id, { env, revisionCount: 0, rootMsgId: env.msg_id });
  const rendered = renderInboundForUser(env);
  const toolHint = `\nUse respond_to_request({msg_id: "${env.msg_id}", action: "approve"|"reject"|"revise"|"escalate", note?}) to respond.`;
  sendMessage(env.msg_id, rendered + toolHint);
}
```

The `updatePendingMsgId` method that's already exposed can be inlined or used here — your choice. If used directly, the test for it (Step 3 above) becomes redundant with the higher-level dispatch test.

### Step 4 — supervisor.prompt.md note

Add a paragraph: "When a submission arrives with `[revision N]` in the prompt, the worker is iterating on a previous submission of yours. The revision count is already enforced (cap 3); on the third revision, your only options are approve or reject."

## Scope — what's NOT in

- **No changes to the cap mechanism.** Already enforced in 3c; just being exercised now.
- **No new envelope kinds.** The thread linkage is just `in_reply_to` on a regular `submission`.
- **No artifacts diff between revisions.** The supervisor sees the new submission's full artifacts; comparing with the previous version is the model's job (or a future enhancement).
- **No revision history persistence.** Once the supervisor approves/rejects, the thread is closed. The workers' session memory holds the conversation history.
- **No client-side timeout coordination across revisions.** Each `shipSubmission` call has its own timeout (5 min default). If a worker is mid-revision and the original timer expired, that's fine — the new ship starts a fresh timer.

## Step-by-step checklist

```
[ ]  1. Read prereqs.
[ ]  2. /tdd.
[ ]  3. Branch claude/phase-4c-revision-threading from main.

  RED → GREEN per step:
[ ]  4. Worker-side test: shipSubmission with revisionNote causes
        sendUserMessage; queue is cleared; lastSubmissionMsgId stored.
[ ]  5. Worker implementation: deferred-confirm fork's revise branch
        + storeLastSubmissionMsgId + thread the next submission's
        in_reply_to.
[ ]  6. Supervisor-side test: dispatchEnvelope with in_reply_to
        matching a pending entry updates rather than creating;
        revisionCount preserved.
[ ]  7. Supervisor implementation: dispatchEnvelope's revision-
        continuation branch.
[ ]  8. supervisor.prompt.md update.

[ ]  9. npm test — green.
[ ] 10. Tmux smoke (worker + supervisor pair):
        a) Worker submits → supervisor revise → worker receives note
           and re-emits modified draft → supervisor approves second
           submission → file applied with revised content.
        b) Worker hits revision cap (3 revises) → supervisor's revise
           action returns error → supervisor must approve or reject.
[ ] 11. Commit per logical step; push; delete this plan file.
```

## Acceptance criteria

- Worker's deferred-confirm correctly re-prompts the model with the revise note.
- Worker's next submission has `in_reply_to` set to the original msg_id.
- Supervisor's `dispatchEnvelope` recognises revision continuations.
- Cap test passes (4th revise from supervisor → error returned by `respond_to_request`).
- Tmux smoke covers both happy revision and cap-hit cases.
- This plan file deleted.

## Hand-back

Push to `origin/claude/phase-4c-revision-threading`. Report SHAs (one per logical step), npm test output, both tmux test results, and any subtle interactions you discovered between worker and supervisor sides.

Don't open a PR.
