# Phase 3a — extend `_lib/bus-envelope.ts` with new payload kinds

**Goal.** Add `approval-request`, `approval-result`, `revision-requested`, and `submission` to the `Payload` discriminated union, plus the `Artifact` type the submission payload carries. Add constructors for each, extend `tryDecodeEnvelope` to validate the new kinds, extend `renderInboundForUser` to give them sensible fallbacks. Tests for everything.

**Behaviour after this phase: identical to before.** Nothing emits or consumes the new kinds yet — they're encodable but no rail produces or routes them. Phase 3b/3c/4 wire them up. This is types + tests only.

This file is deleted in the PR that ships Phase 3a.

---

## Prerequisite

Phases 0.5, 0.6, 1, 2 (incl. cleanup) merged to main. `_lib/bus-envelope.ts` exists; `npm test` works.

## Required reading

- `pi-sandbox/.pi/extensions/_lib/bus-envelope.ts` and `bus-envelope.test.ts` — current state.
- `docs/adr/0003-supervisor-llm-in-review-loop.md` — the four supervisor actions and the envelope kinds they imply.
- `docs/adr/0001-mesh-subsumes-delegation.md` — the migration shape.
- `docs/phases/_notes-for-phase-3.md` — inherited observations.

## Skill to invoke

`/tdd`. Tests first; the new kinds are pure data with discriminated-union shape — exactly the test-friendly territory.

## Branch strategy

Branch from latest `main`. Suggested: `claude/phase-3a-envelope-kinds`.

```sh
git fetch origin main
git checkout -b claude/phase-3a-envelope-kinds origin/main
npm test   # confirm vitest works
```

## Scope — what's in (TDD order)

### Step 1 — tests first (red)

In `pi-sandbox/.pi/extensions/_lib/bus-envelope.test.ts`, add:

- `makeApprovalRequestEnvelope({from, to, title, summary, preview, in_reply_to?})` builds an envelope with `payload.kind === "approval-request"` and the three string fields.
- `makeApprovalResultEnvelope({from, to, in_reply_to, approved, note?})` — `approved: boolean` required, `note: string` optional.
- `makeRevisionRequestedEnvelope({from, to, in_reply_to, note})` — `note` required.
- `makeSubmissionEnvelope({from, to, summary?, artifacts, in_reply_to?})` — `artifacts: Artifact[]`.
- `tryDecodeEnvelope` accepts each new kind with valid fields; rejects each with type-mismatched / missing required fields. One assertion per malformed input.
- `renderInboundForUser` produces:
  - `[approval request from <peer>] <title>` for approval-request.
  - `[approval result from <peer>: approved|rejected]` for approval-result.
  - `[revise from <peer>] <note>` for revision-requested.
  - `[submission from <peer>] <N> artifacts: <summary>` for submission.

Run `npm test` — every new test fails (red). Confirms the harness sees them.

### Step 2 — implementation (green)

In `pi-sandbox/.pi/extensions/_lib/bus-envelope.ts`:

```ts
export type Artifact =
  | { kind: "write"; relPath: string; content: string; sha256: string }
  | { kind: "edit"; relPath: string; sha256OfOriginal: string;
      edits: Array<{ oldString: string; newString: string }> }
  | { kind: "move"; src: string; dst: string; sha256OfSource: string }
  | { kind: "delete"; relPath: string; sha256: string };

export type Payload =
  | { kind: "message"; text: string }
  | { kind: "approval-request"; title: string; summary: string; preview: string }
  | { kind: "approval-result"; approved: boolean; note?: string }
  | { kind: "revision-requested"; note: string }
  | { kind: "submission"; artifacts: Artifact[]; summary?: string };
```

Constructors and decoder updates follow the existing pattern in the file. The decoder validates `Artifact[]` shape inside `submission` (each entry has a valid `kind` and the kind-specific required fields).

### Step 3 — refactor

Tighten naming, JSDoc, deduplicate validation helpers if useful. Tests stay green.

## Scope — what's NOT in

- **No `agent-bus.ts` changes.** `handleIncoming` already routes only `message` kind to inbox/pushToModel; non-message kinds get the existing `(${kind})` fallback in inbox rendering. Don't change `handleIncoming` in 3a — it gets its supervisor-routing dispatch in 3c.
- **No new tools.** No `respond_to_request` (Phase 3c).
- **No new rails.** No supervisor extension (Phase 3c).
- **No Habitat changes.** New `supervisor`/`submitTo`/`acceptedFrom`/`peers` fields are Phase 3b.
- **No actual sending of new-kind envelopes from anywhere.** Nothing in main code emits them yet.
- **No `agent_call` typed-reply changes.** The pending-call resolution still resolves with `""` for non-message replies (forward-compat fallback). The fix lands in Phase 3c when there's an actual rail consuming the new kinds.

## Step-by-step checklist

```
[ ]  1. Read prereqs + ADR-0003 + notes file.
[ ]  2. Invoke /tdd.
[ ]  3. Branch claude/phase-3a-envelope-kinds from main.

  RED:
[ ]  4. Add tests for the four constructors.
[ ]  5. Add tests for tryDecodeEnvelope's new-kind validation
        (happy path + per-field type mismatches + missing required fields).
[ ]  6. Add tests for renderInboundForUser's new-kind output.
        Confirm `npm test` shows them all failing.

  GREEN:
[ ]  7. Add Artifact type.
[ ]  8. Extend Payload union.
[ ]  9. Add four constructors.
[ ] 10. Extend tryDecodeEnvelope's validation (including Artifact[] shape).
[ ] 11. Extend renderInboundForUser to handle each kind.

  REFACTOR:
[ ] 12. Tighten naming, JSDoc; dedupe validation helpers.

[ ] 13. npm test — all green.
[ ] 14. Commit, push, delete this file in same PR.
```

## Testing

Unit only. `npm test`. No tmux needed — nothing observably changes outside the test suite.

## Acceptance criteria

- All four constructors + Artifact type + extended decoder/renderer.
- Tests cover happy paths + every malformed-input mode for new kinds.
- Test count grows by roughly 25–35 assertions (4 constructors × 2-3 happy-path checks + 4 kinds × 3-5 malformed-input checks + 4 render cases).
- `npm test` passes.
- `agent-bus.ts`, all rails, all recipes — unchanged.
- This file (`docs/phases/phase-3a-envelope-kinds.md`) deleted in the same commit/PR.

## Hand-back

Push to `origin/claude/phase-3a-envelope-kinds`. Report:

- Commit SHA.
- Output of `npm test` (assertion count delta).
- Anything you found in the existing decoder/renderer code that needed cleanup along the way.

Don't open a PR. The user reviews the branch directly.
