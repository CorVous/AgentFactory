# Phase 4b — supervisor-side submission apply

**Goal.** Supervisor's `respond_to_request({action: "approve"})` on an inbound `submission` actually *applies* the artifacts to the supervisor's canonical sandbox. Verifies SHA-256 receipts before applying; aborts on mismatch (drift detection). Replies `approval-result {approved: true}` on success, `{approved: false, note: "<error>"}` on failure.

**Behaviour after this phase:**
- A supervisor receiving a submission and approving it actually performs the writes/edits/moves/deletes on its canonical filesystem.
- SHA-256 receipts on each artifact are verified against the canonical filesystem before the artifact is applied; any mismatch aborts the entire batch (atomic).
- The `respond_to_request` tool's existing reject/revise/escalate paths are unchanged.
- Reject/revise/escalate on a submission do not write anything to the canonical filesystem.

This file is deleted in the PR that ships Phase 4b.

---

## Prerequisite

Phases 3a / 3b / 3c merged to main. Phase 4a *not* required — 4b's tests use synthetic submission envelopes (the unit tests already do).

**Parallelisable with Phase 4a and 6a.** Contract with 4a is the `Artifact` type from `_lib/bus-envelope.ts` (already locked).

## Required reading

- `docs/adr/0001-mesh-subsumes-delegation.md` and `0003-supervisor-llm-in-review-loop.md`.
- `docs/phases/_notes-for-phase-3.md` and `_notes-for-phase-4.md` (if present).
- `pi-sandbox/.pi/extensions/_lib/bus-envelope.ts` — `Artifact` shape.
- `pi-sandbox/.pi/extensions/_lib/supervisor-inbox.ts` — the `approve` action you're extending.
- The four `deferred-*.ts` extensions' existing `apply()` paths — they're the reference implementation for "given an operation, do it on the filesystem." Mirror their logic for the supervisor's apply path, but operating on the supervisor's canonical sandbox (until Phase 6 splits scratch vs canonical, the supervisor's `getHabitat().scratchRoot` doubles as canonical).

## Skill to invoke

`/tdd`. Apply logic is pure I/O over a small filesystem; testable with vitest using `fs.mkdtempSync` for an isolated apply target.

## Branch strategy

Off latest `main`. Suggested: **`claude/phase-4b-supervisor-apply`**.

```sh
git fetch origin main
git checkout -b claude/phase-4b-supervisor-apply origin/main
npm test   # confirm baseline
```

## Scope — what's in (TDD order)

### Step 1 — `_lib/submission-apply.ts` (testable core)

**Tests first** in `pi-sandbox/.pi/extensions/_lib/submission-apply.test.ts`. For each artifact kind, cover:

- **Happy path:** apply succeeds, file state matches expectation.
- **SHA mismatch:** rejected before apply, no fs change.
- **Missing file** (for edit/move/delete): rejected, no fs change.
- **Existing-file overwrite** for write: succeeds (no-edit rail's job to enforce create-only when applicable; the apply path itself does not gate on existence).
- **Atomic batch:** if any artifact in a list fails verification, *none* are applied — the entire batch is rejected with a list of error reasons.
- **Apply order:** writes → edits → moves → deletes (mirrors the existing `deferred-confirm` priority order, so the same compositions that work today continue to work).

**Then implementation:**

```ts
export interface ApplyResult {
  ok: boolean;
  applied: string[];   // relPaths successfully applied
  errors: string[];    // human-readable errors (empty when ok)
}

export async function applyArtifacts(
  canonicalRoot: string,
  artifacts: Artifact[],
): Promise<ApplyResult>;
```

Two-pass apply:

1. **Verify pass:** for each artifact, check the SHA-256 against the current file contents (where applicable):
   - `write`: no verify (creates new content; SHA is informational).
   - `edit`: read current content, hash, must equal `sha256OfOriginal`.
   - `move`: read source, hash, must equal `sha256OfSource`. Destination must not exist.
   - `delete`: read current content, hash, must equal `sha256`.
   Build an error list. If any errors, return `{ok: false, errors}` without touching the fs.
2. **Apply pass:** apply each artifact in order (writes → edits → moves → deletes). Each successful apply appends to `applied`; failures append to `errors`. Returns `{ok: errors.length === 0, applied, errors}`.

### Step 2 — extend supervisor's `approve` action

In `pi-sandbox/.pi/extensions/_lib/supervisor-inbox.ts`'s `respondToRequest`'s `approve` branch:

- If the pending entry's envelope is a `submission` (not an `approval-request`):
  - Resolve `canonicalRoot` from `getHabitat().scratchRoot` (until Phase 6 introduces a separate `canonicalRoot` field, the supervisor's scratchRoot doubles as canonical — its filesystem *is* its source of truth).
  - Call `applyArtifacts(canonicalRoot, payload.artifacts)`.
  - On `{ok: true}`: send `approval-result {approved: true}` reply.
  - On `{ok: false}`: send `approval-result {approved: false, note: "apply failed: ${errors.join("; ")}"}`.
- If the pending entry is an `approval-request` (not a submission): existing behavior — just send `approval-result {approved: true}` (no apply, since approval-requests don't carry artifacts).

### Step 3 — `supervisor.ts` wires the apply path

The extension's `respond_to_request` tool implementation (where it calls `state.inbox.respondToRequest`) needs to make `applyArtifacts` available to the inbox. Cleanest path: `_lib/supervisor-inbox.ts` imports `applyArtifacts` directly from `_lib/submission-apply.ts`. No changes to `supervisor.ts`'s tool wiring required.

If you find a test-ergonomics reason to inject the apply function via callback instead, do so — but the direct-import path is simpler for v1.

### Step 4 — docs

- `docs/agents.md`: extend the supervisor section to describe what `approve` does for `submission` envelopes (apply to canonical) vs `approval-request` (just acknowledge).
- `pi-sandbox/.pi/extensions/supervisor.prompt.md`: add a paragraph: "approve on a submission applies the artifacts to your canonical sandbox; SHA mismatches abort the entire batch and the reply will indicate failure."

## Scope — what's NOT in

- **No worker-side emit.** Phase 4a. For 4b, tests construct synthetic `submission` envelopes directly.
- **No revision threading.** Phase 4c.
- **No `canonicalRoot` Habitat field.** Phase 6 might add one. For 4b, `scratchRoot` doubles as the supervisor's canonical (the supervisor's directory *is* its source of truth).
- **No changes to `respond_to_request`'s tool schema.** Just the implementation.
- **No new envelope kinds.** All in 3a.
- **No worker-side handling of approval-result.** Phase 4a's territory; on 4b's branch, tests use synthetic envelopes and assert on the reply envelope's payload directly.

## Step-by-step checklist

```
[ ]  1. Read prereqs.
[ ]  2. /tdd.
[ ]  3. Branch claude/phase-4b-supervisor-apply from main.

  RED:
[ ]  4. _lib/submission-apply.test.ts — happy paths + SHA mismatches +
        atomic batch failure for each artifact kind + apply-order.

  GREEN:
[ ]  5. _lib/submission-apply.ts — verify pass + apply pass.

  INTEGRATION:
[ ]  6. _lib/supervisor-inbox.ts — extend approve action to call
        applyArtifacts when envelope is a submission.
[ ]  7. supervisor.ts — verify no wiring changes needed (imports
        flow through the inbox lib).
[ ]  8. docs/agents.md — supervisor section update.
[ ]  9. supervisor.prompt.md — apply note for the model.

[ ] 10. npm test — green.
[ ] 11. Tmux smoke (synthetic submission envelope from a Node script
        targeting a supervisor recipe, exercising approve / reject /
        revise / escalate). The unit tests already cover the action
        graph; this is the integration confirmation.

[ ] 12. Commit per logical step.
[ ] 13. Push; delete this plan file.
```

## Acceptance criteria

- `_lib/submission-apply.ts` exists with `applyArtifacts` implementing two-pass verify-then-apply.
- Supervisor's `approve` action invokes the apply path for `submission` envelopes; reply contains success/failure.
- SHA-mismatch test passes (file unchanged after rejected verify; reply has `approved: false` with error note).
- Atomic-batch test passes (one bad SHA in a list → none applied).
- Tmux smoke: synthetic submission → approve → file applied to canonical.
- Tmux smoke: synthetic submission with bad SHA → approve → no file change, reply contains error.
- This plan file deleted.

## Hand-back

Push to `origin/claude/phase-4b-supervisor-apply`. Report SHAs, npm test output, tmux smoke results (both happy and bad-SHA cases), and any contract issues with Phase 4a.

Don't open a PR.
