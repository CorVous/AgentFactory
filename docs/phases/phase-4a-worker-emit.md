# Phase 4a — worker-side submission emit

**Goal.** When `getHabitat().submitTo` is set on a worker peer, the `deferred-*` extensions' end-of-turn flow ships a `submission` envelope to the `submitTo` peer instead of locally rendering an approval dialog. Worker waits for the reply (`approval-result`); on approve, no local apply (supervisor handles it); on reject, log and discard. Revision handling lands in a separate phase (4c) — for 4a, treat `revision-requested` as `reject + log`.

**Behaviour after this phase:**
- Recipes that set `submitTo` get the new bus-routed submission flow.
- Recipes that don't set `submitTo` keep today's local-or-rpc-sock flow exactly.
- Workers that emit submissions don't write to disk in their own scratch — only the supervisor's apply path (Phase 4b) writes to canonical.

This file is deleted in the PR that ships Phase 4a.

---

## Prerequisite

Phases 3a / 3b / 3c merged to main. Phase 4b *not* required — 4a's tests use synthetic supervisor receivers via mocked sockets.

**This phase is parallelisable with Phase 4b and Phase 6a.** Coordinate at the artifact contract (locked in `_lib/bus-envelope.ts`'s `Artifact` type) and the wire protocol; otherwise touch separate files.

## Required reading

- `docs/adr/0001-mesh-subsumes-delegation.md` and `0003-supervisor-llm-in-review-loop.md`.
- `docs/phases/_notes-for-phase-3.md` and `_notes-for-phase-4.md` (if present) — inherited observations.
- `pi-sandbox/.pi/extensions/_lib/bus-envelope.ts` — the `Artifact` and `Payload` shapes you're constructing.
- `pi-sandbox/.pi/extensions/deferred-confirm.ts` — the agent_end coordinator you're forking.
- All four `deferred-*.ts` extensions (write/edit/move/delete) — read the existing `prepare()` results to understand what each carries.
- `pi-sandbox/.pi/extensions/agent-bus.ts` — how typed dispatch routes inbound envelopes; you'll add a sibling hook for worker-side submission replies.

## Skill to invoke

`/tdd`. Submission emit is testable in isolation with mocked socket transports.

## Branch strategy

Off latest `main`. Suggested: **`claude/phase-4a-worker-emit`**.

```sh
git fetch origin main
git checkout -b claude/phase-4a-worker-emit origin/main
npm test   # confirm baseline
```

## Scope — what's in (TDD order)

### Step 1 — `_lib/submission-emit.ts` (testable core)

**Tests first** in `pi-sandbox/.pi/extensions/_lib/submission-emit.test.ts`:

- `buildWriteArtifact({relPath, content})` returns `{kind: "write", relPath, content, sha256}` with the correct SHA-256 of content.
- `buildEditArtifact({relPath, originalContent, edits})` returns the edit artifact with `sha256OfOriginal` correctly computed.
- `buildMoveArtifact({src, dst, sourceContent})` returns `{kind: "move", src, dst, sha256OfSource}`.
- `buildDeleteArtifact({relPath, content})` returns `{kind: "delete", relPath, sha256}`.
- `shipSubmission` builds a `submission` envelope, sends it via the injected sender callback, registers a pending entry keyed by `msg_id`, and returns a Promise that resolves when a matching reply is dispatched.
- The dispatch callback (called when an `approval-result` or `revision-requested` envelope arrives with a matching `in_reply_to`) resolves the pending Promise with the reply's typed payload.
- Timeout (default 5 minutes; injectable for tests): rejects the pending Promise.

**Then implementation:**

```ts
export function buildWriteArtifact(args: { relPath: string; content: string }): Artifact;
export function buildEditArtifact(args: {
  relPath: string;
  originalContent: string;
  edits: Array<{ oldString: string; newString: string }>;
}): Artifact;
export function buildMoveArtifact(args: { src: string; dst: string; sourceContent: string }): Artifact;
export function buildDeleteArtifact(args: { relPath: string; content: string }): Artifact;

export interface PendingSubmission {
  resolve: (reply: { approved: boolean; note?: string; revisionNote?: string }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export function getPendingSubmissions(): Map<string, PendingSubmission>;

export interface ShipContext {
  busRoot: string;
  agentName: string;
  submitTo: string;
  sendEnvelope: (env: Envelope) => Promise<{ delivered: boolean; reason?: string }>;
  timeoutMs?: number;
}

export async function shipSubmission(
  ctx: ShipContext,
  artifacts: Artifact[],
  summary?: string,
): Promise<{ approved: boolean; note?: string; revisionNote?: string }>;
```

The pending-submissions Map is stashed on globalThis (mirroring `agent-bus`'s `pendingCalls`) so `agent-bus.ts` can dispatch replies into it from a different module.

### Step 2 — agent-bus dispatch hook for submission replies

In `pi-sandbox/.pi/extensions/agent-bus.ts`'s `handleIncoming`, after the existing `pendingCalls` check (which now correctly rejects non-message replies per Phase 3c) but **before** the `acceptedFrom`-gated supervisor dispatch:

- If `env.in_reply_to` is set AND the envelope kind is `approval-result` or `revision-requested`:
  - Look up `getPendingSubmissions().get(env.in_reply_to)`.
  - If found: clear the timer, delete the pending entry, resolve the promise with the typed payload.
  - If not found: fall through (envelope continues to supervisor dispatch / inbox).

This is an additive change — it doesn't break existing behavior. Add a single test to `agent-bus`'s test file (or a new one) that exercises the hook with a mocked pending submission.

### Step 3 — extend `PrepareResult` to carry artifacts

In `pi-sandbox/.pi/extensions/deferred-confirm.ts`, extend the `ok` variant of `PrepareResult`:

```ts
export type PrepareResult =
  | { status: "empty" }
  | { status: "error"; messages: string[] }
  | {
      status: "ok";
      summary: string;
      preview: string;
      apply: () => Promise<{ wrote: string[]; failed: string[] }>;
      artifacts?: Artifact[];   // NEW: when set, supervisor-routed flow uses these
    };
```

Existing handlers that don't populate `artifacts` continue to work (the field is optional).

### Step 4 — each `deferred-*` handler populates artifacts

Update the four `deferred-*.ts` extensions to populate `result.artifacts` in their `prepare()` ok results:

- `deferred-write.ts`: each draft → `buildWriteArtifact({relPath, content})`.
- `deferred-edit.ts`: each edit-target file → `buildEditArtifact({relPath, originalContent, edits})` using the original content the handler reads anyway for re-validation.
- `deferred-move.ts`: each move → `buildMoveArtifact({src, dst, sourceContent})` (read source content for the SHA).
- `deferred-delete.ts`: each delete → `buildDeleteArtifact({relPath, content})` (read content for the SHA).

The existing `apply()` method on each handler stays — it's the local-flow fallback when `submitTo` is unset.

### Step 5 — fork `deferred-confirm.ts`'s `agent_end`

Add a branch in the agent_end coordinator:

- If `getHabitat().submitTo` is set:
  - Aggregate all handlers' `result.artifacts` from the prepared `ok` results.
  - Build a summary (e.g. count + per-handler labels).
  - Ship via `shipSubmission`.
  - On `{approved: true}`: `tell(ctx, "info", "submission applied by supervisor")` (no local apply).
  - On `{approved: false}`: `tell(ctx, "info", "submission rejected: ${note ?? "(no reason)"}")`. Don't apply locally.
  - On `revision-requested`: for 4a, treat as reject (log it, discard the queue). 4c handles the actual revision flow.
- If `submitTo` is unset: existing local-or-rpc-sock flow, **unchanged**.

The `submitTo` read uses the same try/catch pattern as other rails:

```ts
let submitTo: string | undefined;
try { submitTo = getHabitat().submitTo; } catch { submitTo = undefined; }
```

### Step 6 — docs

In `docs/agents.md`, append a paragraph under the recipe-shape section: when `submitTo` is set on a recipe, deferred-* drafts are shipped to that peer's supervisor rail at end-of-turn instead of being locally applied. Recipes that don't set `submitTo` keep today's local flow.

## Scope — what's NOT in

- **No supervisor-side apply logic.** Phase 4b builds that. For 4a, tests use mocked supervisor receivers.
- **No revision threading.** Phase 4c. For 4a, treat `revision-requested` reply as `reject + log`.
- **No agent-spawn deletion.** Phase 5.
- **No bundle / workspace seeding.** Phase 5 (atomic delegate spawn flow).
- **No new tools.** Workers continue to call `deferred_write` / `deferred_edit` / etc. as today.
- **No habitat field changes.** `submitTo` already exists from Phase 3b.

## Step-by-step checklist

```
[ ]  1. Read prereqs + ADRs + notes.
[ ]  2. /tdd.
[ ]  3. Branch claude/phase-4a-worker-emit from main.

  RED:
[ ]  4. _lib/submission-emit.test.ts — all 4 builders + shipSubmission +
        timeout + dispatch resolution.

  GREEN:
[ ]  5. _lib/submission-emit.ts — implementations.

  INTEGRATION:
[ ]  6. agent-bus.ts — add submission-reply dispatch hook before
        supervisor dispatch.
[ ]  7. PrepareResult type — add optional artifacts field.
[ ]  8. Each deferred-*.ts — populate result.artifacts in prepare().
[ ]  9. deferred-confirm.ts — fork agent_end on getHabitat().submitTo.
[ ] 10. docs/agents.md — append the submitTo flow paragraph.

[ ] 11. npm test — green.
[ ] 12. Tmux smoke (with synthetic supervisor or pair-test with 4b):
        a worker recipe with submitTo set queues a draft, ships
        submission, gets approve reply, logs success.
[ ] 13. Tmux smoke regression: deferred-writer (no submitTo) still
        renders local confirm dialog and applies on approval.
[ ] 14. Commit per logical step (one commit per file group).
[ ] 15. Push; delete this plan file.
```

## Acceptance criteria

- `_lib/submission-emit.ts` exists with the artifact builders and ship/dispatch logic.
- `agent-bus.ts` correctly forwards approval-result/revision-requested replies to pending submissions.
- All four `deferred-*` handlers populate `result.artifacts` in their `prepare()` ok results.
- `deferred-confirm.ts` correctly forks on `submitTo`.
- `npm test` passes (existing + new).
- Tmux smoke regression: deferred-writer (no `submitTo`) unchanged.
- Tmux smoke new: a worker with `submitTo` set ships submission and logs the supervisor's reply.
- This plan file deleted.

## Hand-back

Push to `origin/claude/phase-4a-worker-emit`. Report SHAs (one per logical step), npm test output, both tmux test results, and any contract issues you discovered with Phase 4b's supervisor-side work.

Don't open a PR.
