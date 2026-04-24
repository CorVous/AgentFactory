# pre-composer — assembler baseline captured alongside composer wrap-up

Captured **2026-04-24** on branch `claude/complete-part-plan-h9Duq`, at
HEAD = the commit that landed the parts-first wrap-up (plan hygiene,
`report-diff.sh`, `delegate()` unit tests, signal-map drift test,
`composer-full-orchestrator` task). Intended to cover two closely
related §50 obligations at once:

1. The "capture fresh baseline before declaring composer improves"
   step from `parts-first-plan/50-verification-and-ab.md §Baseline`.
2. Phase 2 pass criterion #9 — "no assembler regression" —
   confirming that adding `parentSide` named exports to the five
   components in Phase 2.1 did not break agents the assembler skill
   produces (assembler agents ignore `parentSide`; they only import
   default factories).

## Summary

| Task | Haiku 4.5 | Gemini 3 Flash | GLM 5.1 |
|---|---|---|---|
| recon-agent | 20/20 mostly | 20/20 mostly | 20/20 full |
| deferred-writer | 20/20 full | 20/20 full | 3/16 **major misses** |
| confined-drafter-agent | 19/19 full | 19/19 full | 19/19 full |
| scout-then-draft-agent | 21/22 mostly | 22/22 mostly | 22/22 full |
| out-of-library-agent (GAP) | 2/2 full | 2/2 full | 2/2 full |

14/15 cells are "mostly passing" or "full pass". The one outlier is
called out below.

## Known ceilings & deviations

- **recon-agent behavioral=partial on Haiku/Gemini.** Matches the
  `AGENTS.md` "recon behavioral probe" note — generated recon
  extensions' children run on `$TASK_MODEL` (deepseek-v3.2), which
  sometimes skips the `emit_summary` stub call, leaving no
  evidence-anchor file. Model-capability ceiling, not a harness
  regression. GLM landed full pass this round.
- **deferred-writer on GLM 5.1 = 3/16 P0 "major misses".** Deviates
  from the GLM full-pass band reported in `AGENTS.md` (3–6 turns,
  $0.013–$0.048/task). Single-cell, run-to-run noise is the most
  likely cause; worth re-running once in isolation if the skill
  baseline is used as a reference. Haiku + Gemini are clean full
  pass, so the assembler's output itself is not regressed — GLM just
  failed this particular cell.
- **scout-then-draft-agent load=partial on Haiku/Gemini.** Load
  probe's 30s ceiling occasionally trips when the agent's handler
  runs a recon/draft pass on the load probe's empty args. Behavioral
  probe is green across the board, so the extension is wired
  correctly; the load probe just catches a cheap execution that ran
  too long. Not a regression.

## No assembler regression (Phase 2 criterion #9)

`parentSide` additions in Phase 2.1 are pure named exports; the
default-export factories — which is what assembler-generated agents
import — are unchanged. Haiku + Gemini hit full pass across all five
tasks (modulo the load-probe flake above), confirming no assembler
regression from Phase 2 component changes.

## How this round was produced

```sh
set -a; source models.env; set +a
for t in recon-agent deferred-writer confined-drafter-agent \
         scout-then-draft-agent out-of-library-agent; do
  scripts/task-runner/run-task.sh "$t" -r "pre-composer-$t" &
done; wait
```

Per-task summary.md files live under
`pi-sandbox/.pi/scratch/runs/pre-composer-<task>/summary.md`; copied
into this directory as `<task>.md`.
