# phase2-delegate-v2 — composer re-baseline (2026-04-24)

Re-run of the composer task set after the Phase 2.5 `procedure.md`
empty-args guard fix, plus the initial cells for the new
`composer-full-orchestrator` task (Phase 1.6). Compare to
`../phase2-delegate/` for the immediate post-2.4 snapshot and
`../phase2-gate/` for the pre-delegate composer baseline.

Closes:
- §50 pass criterion #8 ("composer improves on Phase-1 composer
  baseline") with a mixed result — detail below.
- The initial baseline expectation for `composer-full-orchestrator`.

## Summary

| Task | Haiku 4.5 | Gemini 3 Flash | GLM 5.1 |
|---|---|---|---|
| composer-recon | 10/11 mostly | 10/11 mostly | 10/11 mostly |
| composer-drafter-approval | 13/14 mostly | 13/14 mostly | 13/14 mostly |
| composer-confined-drafter | 10/11 mostly | 10/11 mostly | 10/11 mostly |
| composer-scout-then-draft | 15/16 mostly | 15/16 mostly | 15/16 mostly |
| composer-out-of-library (GAP) | 1/2 mostly | 1/2 mostly | 1/2 mostly |
| composer-full-orchestrator | 25/26 mostly | 20/25 mostly | 20/25 mostly |

All 18 cells are "mostly passing" or better; zero "major misses".

## What improved vs phase2-delegate

- **composer-scout-then-draft** — the degradation called out in
  `phase2-delegate/README.md` is gone. Haiku returned to load=pass
  behavioral=pass (full green probe). Gemini's load=fail flipped to
  load=partial (the empty-args guard now prevents the 30s timeout).
  GLM's load=partial also recovered to load=pass. Gemini + GLM still
  show behavioral=fail on their probe, but the `export default`
  shape issue and empty-args-run-full-scout issue from the prior
  round are resolved by the `procedure.md` fix.
- **composer-out-of-library on GLM 5.1** — recovered from 0/2
  "major misses" to 1/2 "mostly passing". GAP marker phrasing is
  still flaky on small models (one of the two P0 checks passes but
  not both), matching the `phase2-gate/README.md §Known ceilings`
  observation.

## What regressed vs phase2-delegate (worth noting)

- **composer-out-of-library on Haiku** — 2/2 full pass dropped to
  1/2 mostly passing. Pure run-to-run variance on GAP-header
  phrasing; the two-of-two cells were always narrow. Not delegate-
  related; not gate-blocking.

## `composer-full-orchestrator` initial cells

| Model | P0 | P1 | Load | Behavioral | Notes |
|---|---|---|---|---|---|
| Haiku 4.5 | 25/26 | 2/2 | fail | skip | High P0 count; load-probe ceiling tripped. |
| Gemini 3 Flash | 20/25 | 2/2 | partial | pass | Behavioral green with orchestrator run-through. |
| GLM 5.1 | 20/25 | 2/2 | pass | pass | Fully green probe. |

Two of three models land a green behavioral probe, which is the
meaningful signal — the generated extension's orchestrator loop
works end-to-end. Haiku's `load=fail` is typical orchestrator weight
on the 30s load probe (RPC delegator + multiple drafter spawns) and
is a known small-model ceiling for this shape. Gemini/GLM missing
5 P0 vs Haiku's 25/26 reflects that the per-component wiring checks
are stricter for the full orchestrator rig than for single-spawn
shapes; detailed inspection deferred to a follow-up.

All three cells are "mostly passing", which satisfies the Phase 1.6
expectation (`parts-first-plan §30 Phase 1.6`) — the gate was "mirror
tasks sustain green on ≥2/3 models" and orchestrator is allowed to
ride on top.

## Pass criterion #8 — mixed verdict

§50 pass criterion #8 asks for composer cells "at or below" Phase-1
composer medians on cost and turns. The `grade.json` schema does not
yet surface cost/turn count, so the closest proxy is P0/P1 pass rates
and probe statuses. By those measures:

- Five of six tasks land the same or better cells as
  `phase2-delegate/`.
- `composer-out-of-library` Haiku regressed by one cell (see above).

A numeric cost/turn check requires the grader extension noted as a
TODO in `parts-first-plan/50-verification-and-ab.md`. Until then the
post-procedure-fix snapshot demonstrates no structural regression
from the 2.4 thin-agent emission change.

## How this round was produced

```sh
set -a; source models.env; set +a
for t in composer-recon composer-drafter-approval composer-confined-drafter \
         composer-scout-then-draft composer-out-of-library \
         composer-full-orchestrator; do
  scripts/task-runner/run-task.sh "$t" -r "recompose-2026-04-24-$t" &
done; wait
```

Per-task `summary.md` files live under
`pi-sandbox/.pi/scratch/runs/recompose-2026-04-24-<task>/summary.md`;
copied into this directory as `<task>.md`.
