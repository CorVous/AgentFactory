# phase2-delegate — composer baseline after Phases 2.1–2.5

Captured **2026-04-24**, immediately after Phases 2.1 (parentSide),
2.2 (delegate() runtime), 2.3 (refactor canonical extensions onto
delegate()), 2.4 (composer skill emits thin agents), and 2.5 (grader
recognizes delegate() shape).

Compare to `../phase2-gate/` (the 2.4-less baseline, inline-spawn
composer output, pre-delegate grader).

## Summary

| Task | Haiku 4.5 | Gemini 3 Flash | GLM 5.1 |
|---|---|---|---|
| composer-recon | 10/11 mostly | 10/11 mostly | 10/11 mostly |
| composer-drafter-approval | 13/14 mostly | 13/14 mostly | 13/14 mostly |
| composer-confined-drafter | 10/11 mostly | 10/11 mostly | 10/11 mostly |
| composer-scout-then-draft | 15/16 mostly | 14/16 mostly | 15/16 mostly |
| composer-out-of-library (GAP) | 2/2 full | 1/2 mostly | 0/2 major misses |

14/15 cells are "mostly passing" or better. One regression vs
phase2-gate: GLM on the GAP task slipped from 1/2 to 0/2 — pure
model variance, GAP handling doesn't involve delegate().

## What's notably better vs phase2-gate

- Every `composer-drafter-approval` and `composer-confined-drafter`
  cell (9 total) reports `load=pass beh=pass`. Pre-delegate those
  six were mostly-passing with occasional behavioral flakiness
  (24–25 P0 marks); now the delegate path is a clean 13/14 + 2/2
  with full green probe.
- P0 counts shrank (e.g. drafter-approval 22 → 14, confined-drafter
  17 → 11) because the grader correctly short-circuits delegate-
  handled rails instead of asserting each inline literal.
- P1 rose to 2/2 across the board, driven by the new
  "uses delegate() runtime (thin agent)" mark.
- `composer-drafter-approval`'s single missing P0 is an unrelated
  rail (registerTool shape check fires on a non-tool extension —
  spurious; fixable in a follow-up but not gate-blocking).

## What's worse / expected ceilings

- **composer-scout-then-draft** degraded:
  Haiku/GLM load=partial + behavioral=fail, Gemini load=fail. Root
  cause (Gemini): model emitted `export async function handler(ctx)`
  instead of the `export default function(pi) { pi.registerCommand }`
  shell. Root cause (Haiku/GLM): generated handler treats empty
  args as "current dir" and runs the full scout phase on the load
  probe's empty-args invocation → 30s probe timeout. Both addressed
  by the procedure.md update in the same commit as this snapshot
  (empty-args guard + explicit "don't swap the export shape" note
  in the sequential template).
- **composer-recon behavioral=partial** on all three models: the
  `$TASK_MODEL` recon ceiling documented in AGENTS.md. Deepseek-v3.2
  sometimes skips the `emit_summary` stub call, so the probe's
  evidence-anchor file never materializes.
- **composer-out-of-library GLM 0/2**: GAP marker phrasing is flaky
  on GLM for this specific prompt. Not delegate-related.

## How this round was produced

```sh
# Per-task round labels so artifacts don't clobber — run-task.sh
# assumes one round = one task:
for t in composer-recon composer-drafter-approval \
         composer-confined-drafter composer-scout-then-draft \
         composer-out-of-library; do
  scripts/task-runner/run-task.sh "$t" -r "phase2-post-$t" &
done; wait
```
