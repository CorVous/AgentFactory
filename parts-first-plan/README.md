# Parts-first plan

Landing plan for moving pi agent construction from **pattern-first**
(five fixed shapes in `pi-agent-assembler/patterns/`) to **parts-first**
(pick whichever components are needed, compose them) — and later,
components that carry their own parent-side glue so agent files can be
thin.

## How this folder is organized

Read in order on first pass; each file is self-contained enough to
re-enter later as a reference.

| File | Scope |
| --- | --- |
| `00-sibling-skill-strategy.md` | Why we stand up `pi-agent-composer` alongside `pi-agent-assembler` instead of refactoring in place. Baseline preservation + A/B mechanics. |
| `10-composer-skill.md` | Phase 1a — new skill file layout: `SKILL.md`, `procedure.md`, `rails.md`, `compositions.md`, `parts/*.md`. |
| `20-composer-grader.md` | Phase 1b — new grader module `graders/composer.ts` + `component-spec.ts` + `test-spec.ts` enum extension. |
| `30-composer-tasks.md` | Phase 1c — component-driven `test.yaml` shape, initial task set, prompt-from-components validator. |
| `40-components-heavy-phase2.md` | Phase 2 — grow components to export `parentSide`; ship `delegate()` helper; refactor canonical extensions; composer emits thin agents. **Gated on Phase 1 green.** |
| `50-verification-and-ab.md` | A/B protocol across `$AGENT_BUILDER_TARGETS`, measurement, what counts as green, regression thresholds. |
| `60-open-questions.md` | Decisions deferred to implementation; record answers here as they land. |

## Guiding principles

1. **Baseline integrity.** `pi-agent-assembler` and its five tasks stay
   exactly as they are. Their grade numbers are our A/B reference.
2. **No destructive edits in Phase 1.** Everything additive — new skill,
   new grader module, new tasks. Deletion only considered post-Phase-2
   after sustained green.
3. **Compose, don't author.** Preserved property from the assembler. The
   composer's job is still to pick parts + apply rails, just without
   being constrained to five pre-built shapes.
4. **Small models stay first-class.** `$AGENT_BUILDER_TARGETS` (Haiku
   4.5, Gemini 3 Flash Preview, GLM 5.1) is the design constraint; if
   the composer regresses GLM below the assembler's $0.013–$0.048/task,
   3–6-turn band, we investigate before widening scope.
5. **Narrow bring-up.** Scaffold + grader ship against one mirror task
   (`composer-drafter-approval`) before the other four; five
   simultaneous A/Bs is a coarse-grained debug loop. See
   `30-composer-tasks.md §Bring-up order`.

## Work branch

`claude/review-project-plan-O6lS8` — this plan and the composer skill
land on the same branch.

## Phase gates

- **Enter Phase 1.4** (initial composer round) only after 1.1–1.3 land.
- **Enter Phase 1.6** (orchestrator task) only after mirror tasks
  sustain green on ≥2/3 `$AGENT_BUILDER_TARGETS` across ≥1 full round.
- **Enter Phase 2** only after Phase 1 sustains green on all three
  `$AGENT_BUILDER_TARGETS` across at least five composer tasks. Phase
  2 does **not** gate on Phase 1.6 — orchestrator is the
  highest-complexity shape and a known small-model ceiling risk.
- **Deletion of `pi-agent-assembler`** is not on this plan. That is a
  separate decision informed by Phase-2 evidence.
