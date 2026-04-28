# Phase 1 — Typed bus envelope

**Goal.** Replace the bus envelope's `body: string` with `payload: { kind, ... }`, with `kind: "message"` as the only kind for now. Extract the wire-format logic into a small library module that future phases (3, 4, 5) extend with new kinds.

**Behaviour after this phase: identical to before.** A peer-to-peer chat still renders as `[from peer] <text>` on the recipient. Nothing else changes. This is a code-shape change to give the bus protocol a home — the foundation for everything else in the migration.

This file should be deleted in the PR that ships Phase 1 (its purpose is one-shot guidance for the implementing session; it has no long-term value once the code is in).

---

## Prerequisite

**Phase 0.5 must have shipped.** This phase practises TDD on the new library module, which requires the vitest harness Phase 0.5 sets up. If `npm test` doesn't exist in `package.json`, stop and ship `docs/phases/phase-0.5-test-infrastructure.md` first.

## Required reading before you start

Read these in order. They were produced by an architecture grilling session that resolved every load-bearing decision; do not relitigate.

1. **`CONTEXT.md`** (repo root) — vocabulary. Especially: `Bus Root`, `Mesh`, `Submission`, `Bundle`, the four supervisor actions. You will not implement most of these in Phase 1, but they tell you where the typed envelope is heading.
2. **`docs/adr/0001-mesh-subsumes-delegation.md`** — the architectural shape this phase is the foundation for.
3. **`docs/adr/0003-supervisor-llm-in-review-loop.md`** — describes the four envelope kinds future phases will add (`submission`, `approval-request`, `approval-result`, `revision-requested`). Your library should make adding them trivial.
4. **`AGENTS.md` and `docs/agents.md`** — project conventions; especially the tmux-based testing pattern under "Debugging the rails" and "Verifying the multi-agent rails under tmux."
5. **`pi-sandbox/.pi/extensions/agent-bus.ts`** (current state on whichever branch you start from) — the file you will edit. Read end-to-end first.

## Skill to invoke before starting

Invoke **`/tdd`** before writing any code. The library module you're building (`_lib/bus-envelope.ts`) is the exact "deep module, narrow interface" shape `tdd/interface-design.md` is written for: 4–5 pure functions with a clear external API. Tests at the library's interface are the test surface; the rest of Phase 1 is a refactor that those tests protect.

The integration check (tmux smoke test, below) stays as the end-to-end gate. The unit tests catch wire-format regressions instantly without paying for tmux startup.

---

## Branch strategy

Branch from the post-Phase-0.5 state of `claude/review-codebase-architecture-5YMYu` (which by then has CONTEXT.md, the three ADRs, the mesh branch merged in, *and* vitest configured). Suggested name: **`claude/phase-1-typed-envelope`**.

```sh
git fetch origin claude/review-codebase-architecture-5YMYu
git checkout -b claude/phase-1-typed-envelope origin/claude/review-codebase-architecture-5YMYu
# Confirm the harness exists; should print vitest config / "no test files found":
npm test
```

If `npm test` errors with "command not found: vitest" or similar, Phase 0.5 hasn't shipped yet — stop and ship that first.

If the mesh branch's `agent_call` / `pendingCalls` correlation logic isn't present in your `agent-bus.ts`, the mesh merge into the base branch hasn't happened yet — work with the simpler envelope shape and note it in the hand-back. Either way, your job is to introduce the typed library + bump `v: 2` regardless of the current concrete shape.

---

## Scope — what's in (TDD order: tests first)

1. **Write `pi-sandbox/.pi/extensions/_lib/bus-envelope.test.ts`** — tests for the library you're about to build, before the library exists. Cover:
   - `makeMessageEnvelope({from, to, text})` produces an envelope with `v: 2`, a fresh UUID `msg_id`, the supplied `from`/`to`/`text`, a numeric `ts`, and `payload.kind === "message"`.
   - `makeMessageEnvelope({from, to, text, in_reply_to})` carries the `in_reply_to`.
   - `encodeEnvelope` produces a single line ending in `\n`; the line parses back to the same envelope (`tryDecodeEnvelope(encodeEnvelope(env))` round-trip).
   - `tryDecodeEnvelope` returns `null` for: not-JSON, wrong `v`, missing `payload`, payload with unknown `kind`, missing required fields, type-mismatched fields. One assertion per malformed input.
   - `renderInboundForUser` produces `[from <peer>] <text>` for envelopes without `in_reply_to`, and `[from <peer> re:<8-char-prefix>] <text>` when it's set. Match the exact format used today (look at the current `pushToModel` in `agent-bus.ts` for the contract).
   - Run `npm test`. Watch every test fail (red) — this confirms the harness sees them.
2. **Create `pi-sandbox/.pi/extensions/_lib/bus-envelope.ts`** — implement until tests pass (green):
   - `Payload` discriminated union (only `{kind: "message"; text: string}` for now; **no other kinds**).
   - `Envelope` interface with `v: 2`, `msg_id`, `from`, `to`, `ts`, `payload`, `in_reply_to?`.
   - `encodeEnvelope(env): string` — JSON.stringify + newline.
   - `tryDecodeEnvelope(line): Envelope | null` — parse + validate (`v === 2`, payload shape OK); returns null on any malformation.
   - `makeMessageEnvelope({from, to, text, in_reply_to?}): Envelope` — constructor.
   - `renderInboundForUser(env): string`.
3. **Refactor `pi-sandbox/.pi/extensions/agent-bus.ts`** to use the library:
   - Replace the inline `Envelope` interface with the library import.
   - `agent_send` tool builds via `makeMessageEnvelope`.
   - `agent_call` tool (if present on your branch) uses `makeMessageEnvelope` for the request and treats replies as message-kind envelopes.
   - The bus server's `data` handler uses `tryDecodeEnvelope` (drop today's hand-rolled `JSON.parse` + shape check).
   - `sendEnvelope` uses `encodeEnvelope`.
   - `pushToModel` uses `renderInboundForUser`.
   - `handleIncoming`'s `in_reply_to` correlation logic stays as-is.
   - Run `npm test` again — library tests still pass.
4. **Bump `v: 1` → `v: 2`** in every code path. Old envelopes with `v: 1` are rejected by `tryDecodeEnvelope` and silently dropped (existing "ignore malformed lines" behaviour). No backward compat — both ends update atomically, and there's no production with old peers in flight.
5. **Update `human-relay.mjs`** (if present on your branch — it lives in `scripts/`) to match. It currently re-implements JSON-line framing in plain JS. Either import the library (it's TS but `human-relay.mjs` is JS — port it as `_lib/bus-envelope.mjs` if needed, or duplicate the small constructors carefully) or update its inline construction to match the new shape and keep them in sync. Pick whichever costs less; document the choice in your PR description.

**Refactor pass after green:** with tests green, look at the library and `agent-bus.ts` together. Anything obviously redundant, badly named, or untyped can be cleaned up — the unit tests will catch any regression. Don't refactor `agent-bus.ts` beyond the wire-format substitution, but inside the library, follow `tdd/refactoring.md`.

---

## Scope — what's NOT in (resist scope creep)

- **No new envelope kinds.** Do not add `submission`, `approval-request`, `approval-result`, `revision-requested`, or `status` — those land in Phases 3, 4, and 6.
- **No `Habitat` module.** That's Phase 2.
- **No supervisor inbound rail or `respond_to_request` tool.** Phase 3.
- **No changes to `agent-spawn.ts`, `agent-status-reporter.ts`, `--rpc-sock`, or `deferred-confirm.ts`.** Those use a separate protocol that's untouched in Phase 1 and gets deleted in Phase 5.
- **No changes to `delegation-boxes.ts`, `agent-header.ts`, `agent-footer.ts`, `sandbox.ts`, `no-edit.ts`, or any `deferred-*.ts` extension.** They aren't bus consumers.
- **No removal of any field from the recipe schema.** Recipes are untouched.

If something feels like it needs to be done as part of this phase, stop and check it against the migration phases listed in `docs/adr/0001-mesh-subsumes-delegation.md`. If it's a later phase, leave it alone.

---

## Step-by-step checklist (red → green → refactor → integration)

```
[ ]  1. Read CONTEXT.md, ADR-0001, ADR-0003, AGENTS.md, current agent-bus.ts.
[ ]  2. Invoke /tdd skill.
[ ]  3. Confirm Phase 0.5 has shipped: `npm test` should run vitest cleanly
        (exit 0, "no test files found" is fine).
[ ]  4. Create branch claude/phase-1-typed-envelope from the base.

  RED:
[ ]  5. Write _lib/bus-envelope.test.ts covering all five exports and their
        error modes (see Scope item 1). Tests should fail to compile / run
        because the library doesn't exist yet — that's expected.

  GREEN:
[ ]  6. Create _lib/bus-envelope.ts with just enough implementation to make
        every test pass. Run `npm test` — all green.

  REFACTOR:
[ ]  7. Look over the library; clean up names, shapes, JSDoc. Tests still
        green after each change.

  INTEGRATION:
[ ]  8. Refactor agent-bus.ts to use the library:
        [ ] envelope shape import
        [ ] agent_send envelope construction via makeMessageEnvelope
        [ ] agent_call (if present) — same
        [ ] bus server's data handler uses tryDecodeEnvelope
        [ ] sendEnvelope uses encodeEnvelope
        [ ] pushToModel uses renderInboundForUser
[ ]  9. If human-relay.mjs exists, update it to construct/parse v:2 envelopes.
[ ] 10. Bump v: 1 → v: 2 everywhere.
[ ] 11. Run `npm test` — all library tests still green.
[ ] 12. Smoke test under tmux (see Testing below). End-to-end round-trip
        confirms the agent-bus.ts integration is correct.
[ ] 13. Commit (clear message describing the shape change), push.
[ ] 14. Delete this file in the same commit/PR.
```

---

## Testing

The bus rails only fire under a real PTY, so `pi -p` print mode can't exercise them. Use tmux. Adapt the `peer-chatter` example from `docs/agents.md`:

```sh
set -a; source models.env; set +a

# Start two peer-chatter agents on a shared bus
tmux new-session -d -s phase1-test -x 200 -y 50 \
  'PI_AGENT_BUS_ROOT=/tmp/phase1-bus npm run agent -- peer-chatter --sandbox /tmp/p1 -- --agent-name planner'
tmux split-window -t phase1-test \
  'PI_AGENT_BUS_ROOT=/tmp/phase1-bus npm run agent -- peer-chatter --sandbox /tmp/p2 -- --agent-name worker-a'
sleep 5

# Send a message planner → worker-a
tmux send-keys -t phase1-test:0.0 \
  'call agent_send to worker-a with body "ping"' Enter
sleep 30

# Verify worker-a received it. Should print on its next turn:
#   [from planner] ping
tmux capture-pane -t phase1-test:0.1 -p | grep -F '[from planner]'

# Cleanup
tmux send-keys -t phase1-test:0.0 '/quit' Enter
tmux send-keys -t phase1-test:0.1 '/quit' Enter
tmux kill-session -t phase1-test 2>/dev/null
```

The `[from planner] ping` line confirms the round-trip works end-to-end with the new envelope. The `[AGENT_DEBUG]` lines you may also see are unrelated.

If you have time and the mesh branch is present, also run a quick `agent_call` round-trip (request + reply) using two peers — same pattern, just with a peer that calls and a peer that replies via `agent_send` with `in_reply_to`.

---

## Acceptance criteria

- `_lib/bus-envelope.ts` exists with the five exports.
- `_lib/bus-envelope.test.ts` exists covering all five exports + their error modes; `npm test` passes.
- `agent-bus.ts` and (if applicable) `human-relay.mjs` reference the library exclusively for envelope construction, encoding, and decoding.
- `v: 2` everywhere; no `v: 1` left.
- The tmux smoke test prints `[from planner] ping` on the recipient peer's screen.
- `agent-spawn.ts`, `agent-status-reporter.ts`, `deferred-*.ts`, `delegation-boxes.ts`, `agent-header.ts`, `agent-footer.ts`, `sandbox.ts`, `no-edit.ts` are **unchanged**.
- Recipe YAMLs are **unchanged**.
- This file (`docs/phases/phase-1-typed-envelope.md`) is deleted in the same commit/PR.

---

## What to do if you hit something unexpected

- **The current `Envelope` shape doesn't match what the ADRs describe** — read `git log -p pi-sandbox/.pi/extensions/agent-bus.ts | head -200` on your start branch. The shape may have already been touched by another phase or by the mesh branch merge. Adapt: your job is to introduce the typed library + bump `v: 2`, regardless of the current concrete shape. If the current shape already has typed payloads, the work shrinks to "extract to library + bump version."
- **A non-bus file appears to use the bus envelope** — that's a sign a previous phase started but didn't finish, or that the bus envelope leaked. Don't try to fix it in Phase 1; record it as a discovered issue in the PR description so a later phase can address.
- **Something in `--rpc-sock`'s protocol (used by `agent-spawn.ts`) looks similar to the bus envelope** — yes, that's the convergence the ADRs flag. Phase 5 unifies them. Don't touch `--rpc-sock` here.
- **`human-relay.mjs` is not present on your branch** — fine, skip step 5.

---

## Hand-back

When the checklist is complete and the smoke test passes, push to `origin/claude/phase-1-typed-envelope` and report:

- Commit SHA.
- Whether the mesh branch's `agent_call` was present (and updated) or absent.
- Whether `human-relay.mjs` was present (and updated) or absent.
- Anything in the codebase that you found unexpectedly coupled to the envelope shape.
- The output of the tmux smoke test.

Do not open a pull request unless explicitly asked. The user reviews the branch directly.
