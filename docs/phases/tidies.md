# Tidies — small follow-ups carried forward through the deepening

**Goal.** Knock down the seven small follow-up items accumulated across spot-checks of Phases 3c through 5. None is architectural; each is 5–50 lines. Bundling them into one phase keeps the PR small but reviewable, and clears the way for Phase 6c on a cleaner base.

**Behaviour after this phase: identical to before** in every observable way except (#6) supervisor inbound dispatch latency, where inbound envelopes surface to the model immediately rather than waiting for the next `turn_end`.

This file is deleted in the PR that ships these tidies.

---

## Prerequisite

All phases through Phase 5 merged to main. `npm test` passes (192 tests). The branch should fork from `origin/main`.

## Required reading

- `docs/phases/_notes-for-phase-3.md` and `_notes-for-phase-4.md` — most of these items are documented there.
- `pi-sandbox/.pi/extensions/supervisor.ts` and `_lib/supervisor-inbox.ts` — items #1, #2, #3, #6 live here.
- `pi-sandbox/.pi/extensions/_lib/submission-apply.ts` and `pi-sandbox/.pi/extensions/deferred/deferred-edit.ts` — item #4.
- `pi-sandbox/.pi/extensions/_lib/submission-emit.ts` and `agent-bus.ts` — item #5.
- `CONTEXT.md` — item #7.

## Skill

`/tdd`. Most items have testable cores; tests-first protects the refactors.

## Branch

Off latest `main`. Suggested: **`claude/tidies`**.

```sh
git fetch origin main
git checkout -b claude/tidies origin/main
npm test   # confirm 192-test baseline
```

## Scope — seven items, one commit each

### Item 1 — `escalateViaBus` uses `tryDecodeEnvelope`

**Where:** `pi-sandbox/.pi/extensions/supervisor.ts`, the `escalateViaBus` function.

The reply parsing currently does `JSON.parse(line)` + manual shape check on `raw?.payload?.kind === "approval-result"`. Replace with `tryDecodeEnvelope(line)` from `_lib/bus-envelope`. Two lines change.

Why: a future change to envelope decoding (checksum, version bump) shouldn't have to update this site separately.

No new tests needed — existing escalation behaviour tests in `_lib/supervisor-inbox.test.ts` cover the path.

### Item 2 — Delete dead `getPendingRegistry()`

**Where:** `pi-sandbox/.pi/extensions/_lib/supervisor-inbox.ts`.

`getPendingRegistry()` returns a globalThis-stashed Map (`__pi_supervisor_pending__`) but `createSupervisorInbox()` uses its own closure-local `pending` Map and never reads from globalThis. The function is unused.

Delete the function and its global key. Verify by grepping for `getPendingRegistry` and `__pi_supervisor_pending__` — should be zero hits after.

### Item 3 — Audit `updatePendingMsgId`

**Where:** `pi-sandbox/.pi/extensions/_lib/supervisor-inbox.ts`.

`updatePendingMsgId` was exposed for revision threading. Phase 4c implemented threading inline in `dispatchEnvelope`'s continuation branch (uses `pending.delete` + `pending.set` directly) rather than calling this method. Audit usage:

```sh
grep -rn updatePendingMsgId pi-sandbox/ scripts/
```

If unused outside its own definition: delete the method + its tests. If used: leave alone and note in the commit that it's preserved for future use.

### Item 4 — Extract `applyUnique` to shared `_lib/string-edit.ts`

**Where:** `_lib/submission-apply.ts` and `pi-sandbox/.pi/extensions/deferred/deferred-edit.ts` both have a copy.

**Tests first** in `_lib/string-edit.test.ts`:
- Empty `oldString` → error.
- `oldString` not found → error.
- `oldString` matches multiple times → error.
- Single match → returns spliced output.

**Then implementation** in `_lib/string-edit.ts`:
```ts
export function applyUnique(
  content: string,
  oldString: string,
  newString: string,
): { ok: true; out: string } | { ok: false; err: string };
```

Update both call sites to import from there; delete the duplicates.

### Item 5 — Extract bus-transport helper to `_lib/bus-transport.ts`

**Where:** `_lib/submission-emit.ts`'s `makeBusSender` and `agent-bus.ts`'s `sendEnvelope` are doing the same thing — open Unix socket, write line, close.

**Tests first** in `_lib/bus-transport.test.ts`:
- Successful send → `{delivered: true}`.
- Connection refused (path doesn't exist) → `{delivered: false, reason: "peer offline"}`.
- Timeout → `{delivered: false, reason: "timeout"}`.

**Then implementation** in `_lib/bus-transport.ts`:
```ts
export interface BusSendResult { delivered: boolean; reason?: string }
export async function sendOverBus(
  busRoot: string,
  toName: string,
  envelopeLine: string,
  timeoutMs?: number,
): Promise<BusSendResult>;
```

Update `_lib/submission-emit.ts`'s `makeBusSender` to delegate. Update `agent-bus.ts`'s `sendEnvelope` to delegate. Both files lose roughly equal code; the new shared helper has one definition + tests.

This is a small foundation Phase 6c benefits from (status emitter will also use `sendOverBus`).

### Item 6 — Fix supervisor inbound `turn_end` dispatch latency

**Where:** `pi-sandbox/.pi/extensions/supervisor.ts`.

Current flow:
1. `agent-bus.handleIncoming` calls `__pi_supervisor_dispatch__`.
2. supervisor's dispatch pushes the rendered text to `__pi_supervisor_pending_msgs__` on globalThis.
3. supervisor's `turn_end` handler drains and calls `pi.sendUserMessage`.

Symptom: an inbound envelope arriving mid-turn isn't surfaced until the *next* `turn_end`. Phase 4c's smoke had to manually poke the supervisor after a worker submitted.

**Fix:** capture `pi` at `session_start` (the supervisor extension already does — it has its own pi reference). Pass `pi.sendUserMessage` directly into `dispatchToSupervisor` via a closure registered at `session_start`, rather than bouncing through globalThis. Drop the `__pi_supervisor_pending_msgs__` queue and the `turn_end` drain handler entirely.

Concrete steps:
- In `supervisor.ts`'s `session_start` handler, store `pi.sendUserMessage` in a typed closure.
- The `dispatchToSupervisor` exported function reads that closure (via globalThis registration) and calls it directly when an envelope arrives.
- Delete the `__pi_supervisor_pending_msgs__` queue and the `pi.on("turn_end", ...)` drain handler.

**Tests:** unit tests in `_lib/supervisor-inbox.test.ts` already use injected `sendMessage` callbacks — they'll continue to pass. Add a new test verifying that the dispatch flow doesn't queue (i.e., dispatch invokes the callback synchronously rather than relying on a turn boundary).

**Smoke verification:** the same writer-foreman tmux smoke from Phase 5 + the worker-revise smoke from Phase 4c should now work without a manual poke between worker submission and supervisor seeing the prompt.

### Item 7 — CONTEXT.md update for "every peer is on the bus"

**Where:** `CONTEXT.md`.

Phase 5's bug-fix promoted `agent-bus` to baseline. CONTEXT.md's **Peer** entry currently says "A running pi process bound to a Bus Root, addressed by its Instance Name." Add a sentence:

> Every peer binds a bus socket at `session_start`, even if its tool palette excludes peer-talk tools (`agent_send`, `agent_call`, etc.).

One line. Documents the new invariant.

## Out of scope

- **No status envelope kind.** Phase 6c.
- **No new widget.** Phase 6c.
- **No changes beyond the seven items.** If you find another tidy opportunity, note it in the PR description; don't ship.

## Step-by-step checklist

```
[ ]  1. Read prereqs.
[ ]  2. /tdd.
[ ]  3. Branch claude/tidies from origin/main.

  ITEMS — one commit each:
[ ]  4. Item 1: escalateViaBus uses tryDecodeEnvelope.
[ ]  5. Item 2: delete getPendingRegistry + global key.
[ ]  6. Item 3: audit updatePendingMsgId; delete or document.
[ ]  7. Item 4: extract applyUnique to _lib/string-edit.ts;
        update two call sites; tests for the helper.
[ ]  8. Item 5: extract sendOverBus to _lib/bus-transport.ts;
        update makeBusSender + agent-bus's sendEnvelope to delegate;
        tests for the helper.
[ ]  9. Item 6: drop turn_end queue; supervisor dispatches directly.
[ ] 10. Item 7: CONTEXT.md one-line addition.

[ ] 11. npm test — green. New helpers add ~10–15 tests; total
        delta should be modest.
[ ] 12. Tmux smoke (item 6 verification): writer-foreman atomic
        delegate without manual poke confirms dispatch latency
        is fixed.
[ ] 13. Push; delete this plan file.
```

## Acceptance criteria

- All seven items shipped in distinct commits.
- `_lib/string-edit.ts` and `_lib/bus-transport.ts` exist with tests; their original duplicate sites delegate to them.
- `supervisor.ts`'s `__pi_supervisor_pending_msgs__` queue and `turn_end` drain are gone.
- CONTEXT.md mentions the bus-binding invariant.
- `npm test` passes (likely +10–15 from new helpers' tests; possibly −a few from item 3's deletions).
- Writer-foreman tmux smoke passes without manual user prompts between worker submission and supervisor surfacing.
- This plan file deleted.

## Hand-back

Push to `origin/claude/tidies`. Report:

- 7 commit SHAs (one per item).
- npm test count delta.
- Output of the writer-foreman tmux smoke confirming item 6's latency fix.
- Whether item 3's `updatePendingMsgId` was deleted or kept (and why).
- Anything you discovered that doesn't fit the seven items (just a note in the PR description; don't ship).

Don't open a PR.
