# Compositions

Three topologies. Pick one with the cascade in `procedure.md` §3.
Each entry below names the canonical reference (a working extension
that already implements every rail) and the rails that apply.

## single-spawn

- **When:** one child, one phase. Recon-style (read-only +
  `emit_summary`), confined-drafter (writes via `sandbox_write`),
  drafter-with-approval (stages via `stage_write`, parent confirms,
  parent promotes).
- **Component sets that infer to this:**
  - `[emit-summary]` — recon, no write channel.
  - `[cwd-guard]` — confined drafter; child writes directly.
  - `[cwd-guard, stage-write]` — drafter with approval (human gate).
  - `[cwd-guard, stage-write, review]` — drafter with LLM review
    gate, no fan-out (`run-deferred-writer ∉ components`).
- **Canonical reference:** a single `delegate()` call from
  `pi-sandbox/.pi/lib/delegate.ts`. The shared runtime owns the
  subprocess rails (spawn frame, NDJSON loop, timeout, cost
  extraction, path validation, confirm/promote). The generated
  extension body is the slash-command registration + one
  `await delegate(ctx, { components, prompt })`. Reference
  implementation: `pi-sandbox/.pi/extensions/deferred-writer.ts`
  (41 lines after the Phase 2.3 refactor).

  ```ts
  await delegate(ctx, {
    components: [CWD_GUARD, STAGE_WRITE],   // substitute declared set
    prompt,
  });
  ```

  For `[emit-summary]` (read-only recon) drop `CWD_GUARD` —
  `delegate()` infers `$TASK_MODEL` and the emit-summary
  harvester; the caller then persists
  `result.byComponent.get("emit-summary").summaries` to
  `.pi/scratch/<title>.md`. For `[cwd-guard]` (confined drafter)
  drop `STAGE_WRITE` — the child writes directly via
  `sandbox_write`.
- **Rails that apply:** 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12. Rail 11
  (dashboard) does NOT apply — no fan-out state to track.

## sequential-phases-with-brief

- **When:** scout-then-draft. Phase 1 child surveys via
  `emit_summary`; parent assembles a brief from the harvested
  summaries; phase 2 drafter spawn receives the brief in-prompt and
  stages writes via `stage_write`.
- **Component sets that infer to this:** `[cwd-guard, emit-summary,
  stage-write]` (when `review ∉ components` and
  `run-deferred-writer ∉ components`).
- **Canonical reference:** two `delegate()` calls — one per phase
  — with the brief assembled in between. The scout call uses
  `[EMIT_SUMMARY]` (no cwd-guard, read-only child). The drafter
  call uses `[CWD_GUARD, STAGE_WRITE]` and receives the brief
  interpolated into its prompt.

  ```ts
  const scout = await delegate(ctx, {
    components: [EMIT_SUMMARY],
    prompt: `Survey ${target}. Use emit_summary for each finding.`,
  });
  const summaries =
    (scout.byComponent.get("emit-summary") as
      | { summaries: { title: string; body: string }[] }
      | undefined)?.summaries ?? [];
  const brief = summaries
    .map((s) => `## ${s.title}\n${s.body}`)
    .join("\n\n");
  if (Buffer.byteLength(brief, "utf8") > BRIEF_MAX_BYTES /* typ. 16 KB */) {
    ctx.ui.notify("brief exceeds budget; aborting", "error");
    return;
  }

  await delegate(ctx, {
    components: [CWD_GUARD, STAGE_WRITE],
    prompt: `${userTask}\n\n<brief>\n${brief}\n</brief>`,
  });
  // delegate() runs the rails.md §10 confirm/promote gate
  // automatically because review ∉ components on this spawn.
  ```

- **Rails that apply:** all single-spawn rails plus a bounded brief
  size (`Buffer.byteLength(brief, "utf8") <= BRIEF_MAX_BYTES`,
  typically 16 KB) before the second spawn.

## rpc-delegator-over-concurrent-drafters

- **When:** persistent RPC delegator LLM dispatches multiple
  drafters via `run_deferred_writer` and reviews their drafts via
  `review`; LLM verdict is the gate, not human confirm.
- **Component sets that infer to this:**
  - `[cwd-guard, stage-write, review, run-deferred-writer]` — full
    orchestrator.
  - Any set containing `run-deferred-writer` (always RPC).
  - Any set containing `review` and not the above
    sequential-phases-with-brief shape (per the cascade ordering;
    catches `[cwd-guard, stage-write, review]` — single-drafter
    LLM-gated, RPC delegator dispatches one drafter).
- **Canonical reference:** `pi-sandbox/.pi/extensions/delegated-writer.ts`
  lines 270–385 (RPC session management),
  513–578 (dispatch fan-out via `Promise.all`),
  623–666 (review verdict harvest + per-task feedback map).
- **Rails that apply:** all single-spawn rails plus rail 11
  (dashboard). The delegator spawn uses `--mode rpc` (not `--mode
  json`); drafter spawns inside the dispatch handler use `--mode
  json` as in single-spawn.

## Composing the fragments

This file is the jumping-off point — no full TypeScript skeletons
live here. The canonical extensions (`deferred-writer.ts`,
`delegated-writer.ts`) are always in scope as references, and each
component's `parts/<name>.md` carries the parent-side wiring
fragment (event anchor, args destructuring, accumulator shape,
finalize behavior). The composer assembles those fragments under
the chosen topology, following the rails checklist in `rails.md`.

If a topology choice is ambiguous (the cascade gives one answer
but the user's prose suggests another), prefer the cascade and
note the implicit topology in a one-line comment at the top of the
generated extension. The grader emits a P1 warning for implicit
topology choices, surfacing them for review.
