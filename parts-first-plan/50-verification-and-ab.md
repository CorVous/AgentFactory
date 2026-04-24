# 50 — Verification & A/B protocol

## Baseline

`pi-agent-assembler` + its five tasks across `$AGENT_BUILDER_TARGETS`.
Per `AGENTS.md`, GLM 5.1 currently converges in 3–6 turns at
$0.013–$0.048/task with full-pass grades. That cost band is the floor.

Capture a fresh baseline round before Phase 1 lands — `pi-agent-composer`
doesn't yet exist, so we're only re-measuring the assembler:

```sh
scripts/task-runner/run-task.sh recon-agent              -r baseline-2026-04-24/assembler
scripts/task-runner/run-task.sh deferred-writer          -r baseline-2026-04-24/assembler
scripts/task-runner/run-task.sh confined-drafter-agent   -r baseline-2026-04-24/assembler
scripts/task-runner/run-task.sh scout-then-draft-agent   -r baseline-2026-04-24/assembler
scripts/task-runner/run-task.sh out-of-library-agent     -r baseline-2026-04-24/assembler
```

Commit the resulting `summary.md` under
`scripts/task-runner/baselines/pre-composer/` for later diff.

## A/B mechanics

Two-slot round structure:

```
pi-sandbox/.pi/scratch/runs/round-composer-<date>/
├── assembler/<task>/<model>/grade.json
└── composer/<task>/<model>/grade.json
```

Invocation per (skill, task, model) cell — wrapped in a shell loop:

```sh
for SKILL in pi-agent-assembler pi-agent-composer; do
  for TASK in recon-agent composer-recon \
              deferred-writer composer-drafter-approval \
              confined-drafter-agent composer-confined-drafter \
              scout-then-draft-agent composer-scout-then-draft \
              out-of-library-agent composer-out-of-library; do
    # Skip pairs where the task's declared skill doesn't match SKILL
    # (tasks embed their own skill; this loop shape is illustrative)
    :
  done
done
```

In practice: each composer task already has `skill: pi-agent-composer`
in its `test.yaml`, and each assembler task has
`skill: pi-agent-assembler`. So running both task sets via
`run-task.sh` already produces the A/B matrix. No custom wrapper
needed.

## Pass criteria for Phase 1

Before declaring Phase 1 done and entering Phase 2:

1. **No P0 regression on mirror tasks.** For every (composer-task,
   model) cell whose assembler counterpart was green in baseline, the
   composer cell must also be green. Specifically:
   - `composer-recon` matches `recon-agent` baseline.
   - `composer-drafter-approval` matches `deferred-writer` baseline.
   - `composer-confined-drafter` matches `confined-drafter-agent`
     baseline.
   - `composer-scout-then-draft` matches `scout-then-draft-agent`
     baseline.
   - `composer-out-of-library` produces byte-identical GAP header as
     `out-of-library-agent` on ≥2/3 models.
2. **Cost & turns regression bound.** For each (mirror-task, model)
   cell, `grade.json.cost_total_usd` and turn count must be within
   +25% of the baseline cell. Median across `$AGENT_BUILDER_TARGETS`
   must be inside the $0.013–$0.048 band for GLM 5.1.
3. **Net-new tasks passing.** `composer-review-only` and
   `composer-full-orchestrator` achieve P0 full-pass on ≥2/3 models.
4. **Prompt lint green.** `npm run validate-prompts` passes on all
   `composer-*` tasks.
5. **Unit tests green.** `npx tsx --test scripts/grader/__tests__/*.test.ts`.

## Pass criteria for Phase 2

Additional gates before declaring Phase 2 done:

6. **`delegate()` unit tests green.**
7. **Canonical-extension behavior preserved.** `deferred-writer.ts`
   and `delegated-writer.ts` refactored onto `delegate()` pass their
   existing probe tasks with no behavioral delta (byte-identical
   promoted files, byte-identical GAP headers, same exit status).
8. **Composer improves on Phase-1 composer baseline.** Re-run all
   composer tasks after 2.4 (thin-agent emission); cost and turn
   count must be *at or below* Phase-1 composer medians. This is the
   "components carrying their own weight pays off" check.
9. **No assembler regression.** Assembler tasks re-run; unchanged
   grades (modulo noise). `parentSide` additions must not break
   legacy agent code.

## Reporting

Per round, produce a single `summary.md` with a table:

```
| task | model | skill | P0 | P1 | turns | cost | headline |
```

Diff against baseline via `scripts/grader/report-diff.sh` (TODO —
small new script, ~30 lines of awk + sort). Regressions surface as
red rows.

## Rollback

If Phase 1 fails pass criteria #1 or #2 on any cell:

1. Investigate: read the transcript in
   `pi-sandbox/.pi/scratch/runs/<round>/<task>/<model>/`.
2. Most likely diagnostic: small model over-harvests signals (picks
   more components than needed) or misses a rail. Fix the skill
   (procedure.md wording, rail clarity) and re-run just the failing
   cells.
3. If a cell regresses consistently across all three
   `$AGENT_BUILDER_TARGETS`, the issue is structural — check
   `component-spec.ts` wiring anchors against the actual produced
   code.
4. `pi-agent-composer` lives as an isolated skill; deleting its dir
   and reverting `test-spec.ts` + `index.ts` restores the repo to
   assembler-only. No forensic work needed.

## Telemetry to capture per round

All of this already lives in `grade.json`; no new telemetry required:

- P0/P1 pass counts
- Load-probe and behavioral-probe status
- `cost_total_usd` (from `message_end` accumulation)
- Turn count (proxy: count of `turn_end` events)
- Tool-call count (proxy: count of `tool_execution_start` events)
- Exit status / timeouts
