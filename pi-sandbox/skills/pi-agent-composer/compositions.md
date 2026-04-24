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
- **Canonical reference (inline-spawn shape):**
  `pi-sandbox/.pi/extensions/delegated-writer.ts::runDrafter`
  (lines 192–267 — child spawn + NDJSON loop in `--mode json`) +
  `validateStagedWrite` / `promoteFiles`
  (lines 387–434 — per-item validation and `fs.writeFileSync` with
  sha256 post-write verify). The recon and confined-drafter shapes
  are simplifications: drop the `stage_write` harvest, drop the
  `ctx.ui.confirm` gate (recon has no writes; confined drafter is
  unattended). `pi-sandbox/.pi/extensions/deferred-writer.ts` was
  the previous single-spawn reference — it is now a thin wrapper
  over `../lib/delegate.ts` after the Phase 2.3 refactor, so the
  inline pattern lives in `delegated-writer.ts` until Phase 2.4
  teaches this skill to emit `delegate()` calls directly.
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
- **Canonical reference:** no single existing extension yet; inline
  this worked example until `composer-scout-then-draft` lands and
  takes over as the canonical reference.

  ```ts
  // Phase 1: scout child (emit-summary only, no write channel,
  // PI_SANDBOX_ROOT NOT set on this spawn — rails 1, 2, 3, 4, 8, 12).
  const scoutResult = await runChild({
    args: ["-e", EMIT_SUMMARY, "--tools", "ls,read,grep,glob,emit_summary", ...],
    env: { ...process.env },        // no PI_SANDBOX_ROOT
  });
  const brief = scoutResult.summaries
    .map((s) => `## ${s.title}\n${s.body}`)
    .join("\n\n");
  if (Buffer.byteLength(brief, "utf8") > BRIEF_MAX_BYTES) {
    throw new Error("brief exceeds budget");
  }

  // Phase 2: drafter child (cwd-guard + stage-write, full rail set).
  // Spawn shape borrowed from
  //   pi-sandbox/.pi/extensions/delegated-writer.ts::runDrafter (192-267)
  //     — single-child json-mode spawn + NDJSON loop
  //   pi-sandbox/.pi/extensions/delegated-writer.ts::{validateStagedWrite,
  //     promoteFiles} (387-434) — validation + sha256 post-write verify.
  const drafterPrompt = `${userTask}\n\n<brief>\n${brief}\n</brief>`;
  const drafterResult = await runChild({
    args: ["-e", CWD_GUARD, "-e", STAGE_WRITE, "--tools", "stage_write,ls", ...],
    env: { ...process.env, PI_SANDBOX_ROOT: sandboxRoot },
    prompt: drafterPrompt,
  });
  // stage-write.finalize handles ctx.ui.confirm + promote (rail 10).
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
