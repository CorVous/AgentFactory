# Phase 3b — extend Habitat with supervisor / submitTo / acceptedFrom / peers

**Goal.** Add four optional fields to `Habitat` covering peer relationships, parse them in the materialiser, surface them through the runner from new optional recipe fields. No rail reads them yet.

**Behaviour after this phase: identical to before.** Recipes can declare new fields without effect; existing recipes continue to work unchanged. The fields are *declarable* and *materialised* but inert until Phase 3c wires the rails that read them.

This file is deleted in the PR that ships Phase 3b.

---

## Prerequisite

Phase 3a merged to main. `npm test` works.

## Required reading

- `pi-sandbox/.pi/extensions/_lib/habitat.ts` and `habitat.test.ts` — current shape.
- `scripts/run-agent.mjs` — recipe parsing + spec construction.
- `docs/adr/0001-mesh-subsumes-delegation.md` — the four field meanings.
- `CONTEXT.md` — `Supervisor`, `submitTo`, `acceptedFrom`, `peers` definitions.
- `docs/phases/_notes-for-phase-3.md`.

## Skill to invoke

`/tdd`. Habitat extension follows the same pattern as 3a — pure data with discriminator-friendly tests.

## Branch strategy

Branch from latest `main`. Suggested: `claude/phase-3b-habitat-peer-fields`.

```sh
git fetch origin main
git checkout -b claude/phase-3b-habitat-peer-fields origin/main
npm test   # confirm 3a's tests pass on the new base
```

## Scope — what's in (TDD order)

### Step 1 — tests first (red)

In `pi-sandbox/.pi/extensions/_lib/habitat.test.ts`:

- `materialiseHabitat` accepts the four new optional fields and preserves them.
- Defaults: `acceptedFrom` and `peers` default to `[]` when absent (list fields, like existing `agents`/`skills`); `supervisor` and `submitTo` default to `undefined` (optional strings).
- Type-mismatched values for any of the four → rejected (consistent with existing field validation).

Run `npm test` — new tests fail.

### Step 2 — implementation (green)

Extend the type:

```ts
export interface Habitat {
  // ... existing fields ...

  // Phase 3b: peer relationships
  supervisor?: string;       // peer name to escalate approvals to
  submitTo?: string;         // peer name to ship submissions to
  acceptedFrom: string[];    // peers allowed to send to this one
  peers: string[];           // peers this one may address
}
```

Extend `materialiseHabitat` to parse the new fields using the existing `optionalString` / `stringList` helpers. Tests pass.

### Step 3 — runner serialisation

In `scripts/run-agent.mjs`:

- Read `recipe.supervisor`, `recipe.submitTo`, `recipe.acceptedFrom`, `recipe.peers` (all optional, all may be missing).
- Validate types: strings for the first two, arrays-of-strings for the last two; reject malformed recipes loudly with `die()`.
- Add to `habitatSpec`. Use the same `...(value ? { field: value } : {})` pattern the runner already uses for other optional fields.

### Step 4 — recipe schema docs

In `docs/agents.md`, append a small note (under the recipe-shape section) describing the four new fields:

- `supervisor: <peer name>` — peer to escalate approvals to.
- `submitTo: <peer name>` — peer to ship submissions to.
- `acceptedFrom: [peer, …]` — incoming peer allowlist.
- `peers: [peer, …]` — outgoing peer allowlist.

Note that the fields are declarable now but no rail enforces them until Phase 3c.

## Scope — what's NOT in

- **No rail changes.** `sandbox.ts`, `agent-bus.ts`, etc. don't yet enforce these fields.
- **No new tools.** `respond_to_request` is Phase 3c.
- **No supervisor extension.** Phase 3c.
- **No new envelope kinds.** Phase 3a covered those.
- **No topology YAML support.** Phase 6.
- **No group references like `@workers`.** Phase 6.
- **No `agent_call` typed-reply changes.** Phase 3c.

## Step-by-step checklist

```
[ ]  1. Read prereqs.
[ ]  2. /tdd.
[ ]  3. Branch claude/phase-3b-habitat-peer-fields from main.

  RED:
[ ]  4. Add tests: materialiseHabitat preserves the four new fields.
[ ]  5. Add tests: defaults for absent fields ([] for lists, undefined
        for strings).
[ ]  6. Add tests: type mismatches are rejected.
        Confirm npm test shows them all failing.

  GREEN:
[ ]  7. Extend Habitat interface.
[ ]  8. Extend materialiseHabitat parsing.

  INTEGRATION:
[ ]  9. Update run-agent.mjs to read recipe fields, validate types,
        add to habitatSpec.
[ ] 10. Update docs/agents.md recipe-shape notes.

[ ] 11. npm test — green.
[ ] 12. Tmux smoke: deferred-writer + peer-chatter + writer-foreman
        all still pass (no behavior change expected).
[ ] 13. Optional: launch a recipe with the new fields set; confirm
        [AGENT_DEBUG] habitat dump shows them.
[ ] 14. Commit, push, delete this file.
```

## Testing

Unit (vitest) + tmux for regression confirmation. No new behavior to exercise — just verify nothing broke.

## Acceptance criteria

- Habitat type + materialiser + runner serialisation handle the four new fields.
- Tests cover preservation, defaults, and rejection.
- A recipe declaring the new fields launches and `[AGENT_DEBUG] habitat:` shows them when set (extend the debug dump if needed).
- A recipe NOT declaring them launches as before; `[AGENT_DEBUG]` shows the existing fields unchanged.
- All three tmux smoke tests still pass (deferred-writer, peer-chatter, writer-foreman).
- `docs/agents.md` has the new field documentation.
- This file (`docs/phases/phase-3b-habitat-peer-fields.md`) deleted in the same commit/PR.

## Hand-back

Push to `origin/claude/phase-3b-habitat-peer-fields`. Report:

- Commit SHA.
- Output of `npm test`.
- Output of each tmux smoke test (the captures that confirm no regression).
- A sample `[AGENT_DEBUG]` line for a recipe that declares the new fields, showing them present.

Don't open a PR.
