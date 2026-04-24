# 70 — Review-only shape (deferred design note)

**Status:** parked 2026-04-24. Next-round work.

The original Phase-1 plan (`30-composer-tasks.md §Net-new tasks`) listed
a `composer-review-only/` task with `components: [cwd-guard, stage-write,
review]` and composition "`single-spawn` with review" — a single-drafter
extension whose output goes through an LLM review before promotion, but
without the full RPC delegator the orchestrator uses.

Attempting to land it as spec'd collides with two tested constraints:

- `inferComposition` (`scripts/grader/lib/test-spec.ts:88`) routes
  `review ∈ components → rpc-delegator-over-concurrent-drafters`. Omit
  `composition:` in `test.yaml` and the grader expects orchestrator
  shape.
- `review.wiringChecks` (`scripts/grader/lib/component-spec.ts`, covered
  by `scripts/grader/__tests__/component-spec.test.ts::wiringChecks:
  review`) asserts `--mode rpc` + `--tools review`. A single-spawn
  JSON-mode extension emitting `review` calls would fail this check
  regardless of `composition:`.

Landing a `composer-review-only` task without first deciding how the
thin review shape actually looks risks either (a) eroding the review
invariant by loosening the wiringCheck, or (b) duplicating the
orchestrator shape under a different name.

## Options for the next round

1. **Loosen `review.wiringCheck` to allow JSON-mode when
   `run-deferred-writer ∉ components`.** Accepts that a review can
   drive a single child in JSON mode; needs the child to emit review
   calls as regular `tool_execution_start` events. Low friction, but
   shifts the review protocol from "persistent RPC dialogue" to
   "one-shot verdict emission" — which changes what `review` is
   semantically.
2. **Two-pi-process shape: drafter spawn → reviewer spawn.** First
   child uses `stage-write` to buffer drafts; second child is invoked
   with the staged content as a prompt and `--tools review`. Parent
   pipes approved plans to promotion. Preserves the "review is always
   RPC/LLM-gated" invariant; adds a second spawn and the matching
   `parentSide.spawnArgs` plumbing.
3. **Inline review inside a single child.** The drafter child itself
   calls `stage_write` and `review` sequentially (one LLM, two tool
   calls). Cheapest to spawn; hardest to keep honest — the same LLM
   drafting and reviewing tends toward self-approval. Would need
   prompt-engineering guardrails.

Any of the three is implementable; none is obviously correct until we
decide what "LLM-gated but non-orchestrator" actually means in
composer's vocabulary. The open question is whether review is
fundamentally a multi-agent protocol (option 2) or a single-agent one
(options 1 + 3).

## When to pick this up

After either:

- A concrete use case lands that wants review-without-fan-out (so the
  design choice is driven by real ergonomics), or
- Phase 2 evidence shows `composer-full-orchestrator` is too heavy for
  the most common review needs.

Until then, users who want review semantics use the orchestrator shape
with a single `run_deferred_writer` dispatch.
