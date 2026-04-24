# 30 — Composer tasks & prompt validator (Phase 1c)

Net-new tasks under `scripts/task-runner/tasks/composer-*/`. Existing
assembler tasks untouched.

## Bring-up order

Land the skill scaffold (§10) and grader (§20) against
**`composer-drafter-approval` only** before authoring the other four
mirror tasks. `deferred-writer.ts` is the cleanest canonical reference
(316 lines, fully working), so the first A/B round debugs the grader
shape against known-good code. Extend to the remaining mirror tasks
(`composer-recon`, `composer-confined-drafter`, `composer-scout-then-draft`,
`composer-out-of-library`) only once the single-task loop is green on
≥2 of 3 `$AGENT_BUILDER_TARGETS`. Five simultaneous A/Bs is a
coarse-grained debug loop.

## test.yaml shape

```
skill: pi-agent-composer
expectation:
  kind: composition
  components: [cwd-guard, stage-write]       # required
  composition: single-spawn                   # optional (see §2 of 60-open-questions.md)
  extra_tools: []                             # optional
prompt: |
  <natural-language prompt that implicitly requires those components>
probe:
  args: " ..."                                # passed to behavioral probe
  evidence_anchor: "..."                      # for recon-style probes
```

Key differences vs assembler task shape:

- `expectation.kind: "composition"` instead of `"assembly"`.
- `components: [...]` is the primary declaration; no `pattern:` field.
- `composition:` is optional and can be auto-inferred.

## Initial task set

Mirror the assembler's five tasks so A/B is apples-to-apples, then add
two component-combo tasks that the assembler can't express cleanly.

### Mirror tasks (same prompts as assembler counterparts)

| Task dir | Components | Composition | Notes |
| --- | --- | --- | --- |
| `composer-recon/` | `[emit-summary]` | `single-spawn` | Same prompt as `recon-agent/`. Child has no write channel. |
| `composer-drafter-approval/` | `[cwd-guard, stage-write]` | `single-spawn` | Same prompt as `deferred-writer/`. |
| `composer-confined-drafter/` | `[cwd-guard]` | `single-spawn` | Same prompt as `confined-drafter-agent/`. Child writes directly via `sandbox_write`. |
| `composer-scout-then-draft/` | `[cwd-guard, emit-summary, stage-write]` | `sequential-phases-with-brief` | Same prompt as `scout-then-draft-agent/`. |
| `composer-out-of-library/` | n/a (`kind: gap`) | n/a | Same prompt as `out-of-library-agent/`. Validates GAP header is byte-identical between skills. |

Not mirroring the orchestrator task yet — it's the highest-complexity
path and we want a baseline on the simpler four before adding it.

### Net-new tasks (test expressivity parts-first unlocks)

| Task dir | Components | Composition | Why it's new |
| --- | --- | --- | --- |
| ~~`composer-review-only/`~~ | `[cwd-guard, stage-write, review]` | `single-spawn` with review | **Deferred 2026-04-24.** The shape contradicts two tested invariants: `inferComposition` routes `review ∈ components → rpc-delegator-over-concurrent-drafters`, and `review.wiringChecks` requires `--mode rpc` + `--tools review`. Landing the task without first deciding how a non-RPC review path should look would either erode the invariant or duplicate the orchestrator. See `70-review-only-shape.md` for the options under consideration. |

`composer-full-orchestrator` moved to Phase 1.6 — see bottom of file.

## Prompt authoring rules

- **Do not name components in the prompt.** The agent has to *choose*
  them from the ask. "Write a drafter with approval" is fine (signals
  → stage-write); "use the stage-write component" is a lint failure.
- **Use phrases from `reading-short-prompts.md`'s signal table** where
  natural — the validator (below) checks that signals map to the
  declared component set.
- **Keep prompts under 500 chars.** Baseline assembler prompts are
  terse; the design constraint is "short natural-language prompt."

## Prompt validator — `scripts/grader/validate-prompt.ts`

Authoring-time lint, NOT a runtime grader check. Invoked as
`npm run validate-prompts` (add to `package.json` scripts).

Logic (~40 lines):

1. Walk `scripts/task-runner/tasks/composer-*/test.yaml`.
2. Load the prompt string + declared `components` set.
3. Scan prompt against `reading-short-prompts.md`'s signal table
   (re-expressed in TypeScript as a `Record<RegExp, ComponentName[]>`
   table in `scripts/grader/lib/signal-map.ts` — ~30 rows).
4. Compute inferred component set from signal matches.
5. Assert inferred ⊇ declared, modulo `cwd-guard` (implicit for any
   write-capable shape, rarely phrased in prompts).
6. Reject prompts containing component filenames as literal substrings
   (`stage-write`, `stage_write`, `emit-summary`, `emit_summary`,
   `cwd-guard`, `run_deferred_writer`, `sandbox_write`).
7. Print a per-task report; exit 1 if any task fails.

Source-of-truth decision: write the markdown parser first — the drift
test described in `60-open-questions.md §4` needs it regardless. If
the parser fits in under 40 lines, use it to auto-generate
`signal-map.ts` at build time directly (no hand-mirror). If the parser
needs more than 40 lines, keep a hand-mirrored `signal-map.ts` and use
the parser only for the drift test. This avoids committing to (a) vs
(b) before seeing what the parser actually costs.

## Invocation examples

```sh
# One-shot composer task
scripts/task-runner/agent-maker.sh composer-drafter-approval \
  -m anthropic/claude-haiku-4.5 --grade

# Full round across $AGENT_BUILDER_TARGETS
scripts/task-runner/run-task.sh composer-drafter-approval \
  -r round-composer-2026-04-24

# Validate prompts (no model calls)
npm run validate-prompts
```

## Unchanged files

- All existing `scripts/task-runner/tasks/{recon-agent,deferred-writer,
  confined-drafter-agent,scout-then-draft-agent,out-of-library-agent}/`
  — these are the assembler baseline.
- `scripts/task-runner/agent-maker.sh` — already generic over `-s`.
- `scripts/task-runner/run-task.sh` — same.

## Phase 1.6 — `composer-full-orchestrator`

| Task dir | Components | Composition |
| --- | --- | --- |
| `composer-full-orchestrator/` | `[cwd-guard, stage-write, review, run-deferred-writer]` | `rpc-delegator-over-concurrent-drafters` |

Full orchestrator as a composition sanity-check. Prompt mirrors
`delegated-writer.ts`'s intent.

Add **after** mirror tasks (1a/1b/1c) sustain green on ≥2/3 models
across ≥1 full round. Rationale: pre-`delegate()`, composer emits the
full RPC orchestrator inline (`delegated-writer.ts` is 701 lines),
which is the worst-fit shape for small-model authorship and risks
masking wins on simpler compositions. Pass criteria for Phase 1.6 are
spelled out in `50-verification-and-ab.md`; Phase 2 does **not** gate
on Phase 1.6.
