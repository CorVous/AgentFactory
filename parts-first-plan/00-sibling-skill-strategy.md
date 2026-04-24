# 00 — Sibling skill strategy

## Context

The initial plan called for refactoring `pi-agent-assembler` in place on
this branch. The user redirected: stand up `pi-agent-composer` as a
sibling skill with its own grader module, leaving the assembler and its
five tasks untouched.

## Why this is the right call

1. **Baseline preservation is free.** The assembler's grade rows
   (`scripts/task-runner/baselines/pre-emit-summary/`) are our A/B
   reference. An in-place refactor forces a backwards-compat shim
   (dual-read `pattern | components` in `test-spec.ts`) so tests stay
   green during migration. A sibling skill skips the shim entirely — the
   assembler never changes shape.
2. **A/B is a single env-var flip.** `scripts/task-runner/agent-maker.sh`
   already takes `-s <skill>`. Running the same prompt through both
   skills on the same model is `-s pi-agent-assembler` vs
   `-s pi-agent-composer` on the same `run-task.sh` invocation — no
   branch checkout dance.
3. **No cross-skill link churn.** The plan's original step 1.5 (update
   `pi-agent-builder/references/{defaults,reading-short-prompts}.md`
   cross-links) becomes a no-op — assembler stays canonical, composer
   adds its own references.
4. **No reverse-pipeline migration.** `scripts/reverse-pipeline/*.ts`
   references pattern names via the assembler workflow; it stays intact.
   Composer gets its own seed mechanism if/when it needs one.
5. **Lower blast radius.** If the composer shape turns out to be wrong,
   we delete the new skill and grader module. Zero forensic work on
   the assembler.

## What's shared vs. what's net-new

### Shared (no change in Phase 1)

- `pi-sandbox/.pi/components/*.ts` — the five canonical components
  (`cwd-guard`, `stage-write`, `emit-summary`, `review`,
  `run-deferred-writer`) are loaded by agents produced from both skills.
  Phase 2 grows them with `parentSide` exports, but that's additive and
  the assembler-produced agents continue to work.
- `pi-sandbox/.pi/extensions/{deferred-writer,delegated-writer}.ts` —
  canonical reference implementations; composer points at them the same
  way the assembler does.
- `pi-sandbox/skills/pi-agent-builder/references/*.md` — unchanged.
  `rails.md` in the composer skill cites these directly.
- `scripts/grader/lib/{core-rails,probes,artifact,rubric}.ts` —
  component-agnostic, shared between graders.
- `scripts/task-runner/agent-maker.sh` + `run-task.sh` — generic over
  skill name.

### Net-new (Phase 1)

- `pi-sandbox/skills/pi-agent-composer/` — whole new skill tree.
- `scripts/grader/graders/composer.ts` — component-centric grader.
- `scripts/grader/lib/component-spec.ts` — per-component wiring-check
  registry.
- `scripts/grader/lib/test-spec.ts` — `skill` enum gains
  `"pi-agent-composer"`; new `ComposerExpectation` schema alongside
  `AssemblyExpectation`.
- `scripts/grader/index.ts` — dispatch on `spec.skill` to choose grader.
- `scripts/task-runner/tasks/composer-*/` — new task files,
  component-driven.
- `scripts/grader/validate-prompt.ts` — authoring-time lint (Phase 1c).

### Future decisions (not in this plan)

- Whether `pi-agent-assembler` ever retires. Only considered if
  composer sustains green across multiple rounds with comparable
  or better small-model cost/turns.
- Whether `patterns/*.md` get deleted. Tied to assembler retirement.

## Naming & triggers

Frontmatter `description:` for `pi-agent-composer/SKILL.md` avoids the
pattern-name triggers (`recon`, `drafter-with-approval`, etc). Instead
triggers on: `compose pi agent`, `parts-first`, `component-driven`,
plus the component names (`cwd-guard`, `stage-write`, `emit-summary`,
`review`, `run-deferred-writer`). This lets the two skills coexist in
a session without fighting for the same trigger phrases — the
assembler keeps pattern-name asks, the composer takes
composition-shaped asks.
