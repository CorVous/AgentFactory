# phase2-gate — composer baseline

First full-coverage baseline for the `pi-agent-composer` skill,
captured on **2026-04-24**. Five composer tasks × three
`$AGENT_BUILDER_TARGETS` (Haiku 4.5, Gemini 3 Flash Preview,
GLM 5.1) = 15 cells. This is the Phase 2 entry gate from
`parts-first-plan/README.md` — "sustained green across all three
targets on at least five composer tasks."

## Summary

| Task | Haiku 4.5 | Gemini 3 Flash | GLM 5.1 |
|---|---|---|---|
| composer-recon | 16/18 mostly | 15/18 mostly | 18/18 mostly |
| composer-drafter-approval | 22/22 full | 22/22 full | 22/22 full |
| composer-confined-drafter | 16/17 mostly | 16/17 mostly | 17/17 full |
| composer-scout-then-draft | 24/25 mostly | 24/25 mostly | 24/25 mostly |
| composer-out-of-library (GAP) | 2/2 full | 1/2 mostly | 1/2 mostly |

All 15 cells are "mostly passing" or "full pass"; zero "major
misses". The drafter-with-approval shape is a clean 3/3 full pass.
The remaining cells miss a single P0 or P1 mark each — mostly
path-validation rails on read-only children, where the rail is
architecturally unnecessary but still grader-asserted.

## Known ceilings (not gate blockers)

- **composer-recon behavioral=partial** across all three targets.
  Matches the `AGENTS.md` "recon behavioral probe" note — generated
  recon extensions' children (also on `$TASK_MODEL`, deepseek-v3.2)
  sometimes skip the `emit_summary` stub call, so the parent's
  NDJSON harvester returns empty and no evidence-anchor file is
  written. Model-capability ceiling, not a harness bug. Options to
  close it (pin the recon probe's child to `$LEAD_MODEL`, log
  child stdout, or relax the evidence check) are deferred.
- **composer-out-of-library on Gemini/GLM = 1/2 P0.** One of the
  two GAP checks (either "no artifacts produced" or "GAP marker in
  final assistant message") is flaky on small models. Haiku is the
  only one that reliably emits the exact GAP header; the other two
  sometimes produce artifacts alongside the refusal or vary the
  marker phrasing. Mitigation is composer skill prose tightening,
  not a harness change.

## How this round was produced

```sh
# One per-task round label (so artifacts don't clobber in the shared
# scratch runs/ dir — run-task.sh assumes one round = one task):
for t in composer-recon composer-drafter-approval \
         composer-confined-drafter composer-scout-then-draft \
         composer-out-of-library; do
  scripts/task-runner/run-task.sh "$t" -r "phase2-baseline-$t" &
done; wait
```

Per-task summary.md files live at
`pi-sandbox/.pi/scratch/runs/phase2-baseline-<task>/summary.md`;
this directory snapshots them as `<task>.md`.
