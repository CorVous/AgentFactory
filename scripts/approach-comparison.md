# Approach comparison — recon grader, Track A vs Track B

Static-evidence-only comparison of two implementations of a recon-agent
grader. No live model calls — both graders run against hand-crafted
fixtures with `SKIP_LOAD=1 SKIP_BEH=1`.

- **Track A** (`claude/refactor-grading-scripts-tf9IY`) —
  monolithic fork of `scripts/grade-deferred-writer.sh`. Single file,
  `scripts/approach-a-monolithic/grade-recon.sh` (~360 scoring lines).
- **Track B** (`claude/composable-rubric-framework-cwOJ8`) —
  framework with `lib/{core-rails,harness}.sh` + `profiles/recon.sh`
  dispatched by `grade-task.sh`. Per-anchor factoring across ~5 files.

Both graders were extracted via `git archive` and run over the same
three fixtures (`pi-sandbox/.pi/scratch/comparison/fixtures/`).

## Verdict

**Ship Track B.** Its factoring is genuinely composable — 7 of the 10
anchors classified IDENTICAL or COSMETIC already live in
`lib/core-rails.sh`, and the other 3 (profile-local negatives) are in
`profiles/recon.sh` by design. Track B's extra discriminating anchor
(`no writer-shape harvest`) was empirically validated on the
writer-as-recon fixture; Track A's equivalent is a warn-level check
narrowly tied to the literal `toolCall.input`, which the reference
writer does not actually use — so Track A's warning never fires on real
writer code. Track A remains strictly better on one anchor (`bounded output` — P0
with regex vs B's P1 substring). The notify threshold difference (A ≥4
vs B ≥2) is a documented design disagreement, not a regression.

Do not delete Track A until ONE regression-preserving change lands in
Track B's recon profile: elevate `bounded output` to P0 and tighten
`Buffer.byteLength` to a regex. ~2 lines in `profiles/recon.sh`.

## Structural diff (per-anchor)

Anchor set is asymmetric: Track A has 16 P0 + 2 P1 (flat). Track B's recon
invokes 15 P0 + 3 P1 (shared `lib/core-rails.sh` + `profiles/recon.sh`;
three core-rails anchors exist but are NOT called on the recon profile —
`register_tool_shape`, `path_validation`, `sandbox_root_escape` — those
apply to writer only).

| # | Anchor label (A's wording) | A pri / loc | B pri / loc | Class | Notes |
|---|---|---|---|---|---|
| 1 | At least one extension file produced | P0 `grade-recon.sh:140` | P0 `profiles/recon.sh:39` | COSMETIC | wording only |
| 2 | files placed at canonical .pi/extensions + .pi/child-tools paths | P0 `grade-recon.sh:151` | P0 `profiles/recon.sh:45` | SUBSTANTIVE | A checks both paths; B only `.pi/extensions/` (recon has no child-tool) |
| 3 | registerCommand in extension | P0 `grade-recon.sh:175` | P0 `core-rails.sh:22` | IDENTICAL | same regex `pi\.registerCommand\(['\"]` |
| 4 | registerTool returns {content, details} (when present) | P0 `grade-recon.sh:198` cond. | — (not called) | A-ONLY | B's `core_grade_register_tool_shape` exists but recon profile does not invoke it |
| 5 | --no-extensions on spawn | P0 `grade-recon.sh:209` | P0 `core-rails.sh:56` | IDENTICAL | same regex `--no-extensions\|"-ne"` |
| 6 | --mode json on spawn | P0 `grade-recon.sh:215` | P0 `core-rails.sh:62` | IDENTICAL | same blob ERE |
| 7 | --tools allowlist is read-only (≥3 of ls/grep/glob/read), no writers | P0 `grade-recon.sh:238` | P0 `profiles/recon.sh:79-85` | SUBSTANTIVE | A requires ≥3 read-only verbs; B requires ≥1. Both forbid the same writer verbs. |
| 8 | --provider openrouter + --model from env | P0 `grade-recon.sh:249` | P0 `core-rails.sh:68` | IDENTICAL | same `grep_any "openrouter" && grep_any "process.env."` |
| 9 | `stdio: ["ignore", "pipe", "pipe"]` | P0 `grade-recon.sh:255` | P0 `core-rails.sh:74` | IDENTICAL | same `blob_has_ere 'stdio: *\[ *"ignore"'` |
| 10 | sandboxRoot captured + cwd pinned on spawn | P0 `grade-recon.sh:261` | P0 `core-rails.sh:80` | IDENTICAL | same two-predicate blob check |
| 11 | hard timeout + SIGKILL on child | P0 `grade-recon.sh:267` | P0 `core-rails.sh:86` | IDENTICAL | same `setTimeout(` + `SIGKILL\|child\.kill\(` |
| 12 | NDJSON parsed line-by-line (JSON.parse over child stdout) | P0 `grade-recon.sh:275` | P0 `core-rails.sh:99` | SUBSTANTIVE | B additionally requires an event-type reference (`tool_execution_start\|message_end\|message_update`). Stricter — catches `JSON.parse` used for non-NDJSON. |
| 13 | harvest final answer from message_end + assistant role | P0 `grade-recon.sh:293` | P0 `profiles/recon.sh:95` | SUBSTANTIVE | A also requires a `"assistant"` role reference; B just needs the event type. A is stricter on the positive check. |
| 14 | no ctx.ui.confirm (recon has no gate) | P0 `grade-recon.sh:311` | P0 `profiles/recon.sh:121` | IDENTICAL | both use `grep_any "ctx.ui.confirm"` |
| 15 | no fs.writeFileSync outside .pi/scratch/ | P0 `grade-recon.sh:330` | P0 `profiles/recon.sh:133` | SUBSTANTIVE | A iterates each `fs.writeFileSync(` call and checks that call-line for a scratch path substring; B just checks the blob contains any `scratch` anchor anywhere. A stricter. |
| 16 | bounded output (.slice(0, N) or Buffer.byteLength check) | **P0** `grade-recon.sh:338` | **P1** `profiles/recon.sh:149` | SUBSTANTIVE | Priority AND regex differ. A: `Buffer\.byteLength\(` regex. B: `"Buffer.byteLength"` substring — matches comments. Compound divergence. |
| 17 | --thinking off + --no-session on recon child | P1 `grade-recon.sh:350` | P1 `profiles/recon.sh:155` | IDENTICAL | same predicate pair |
| 18 | notifies at phase boundaries | P1 ≥4 `grade-recon.sh:362` | P1 ≥2 `profiles/recon.sh:168` | SUBSTANTIVE | threshold differs; both use substring `grep -cH "ctx.ui.notify"` (same comment-collision bug, different thresholds) |
| 19 | no writer-shape harvest (tool_execution_start + args destructure) | — (warn only, `grade-recon.sh:302`) | P0 `profiles/recon.sh:107` | B-ONLY | A notes `toolCall.input` as a warning; B promotes the full set of writer-harvest patterns to a P0 fail |

Tally: 6 IDENTICAL, 2 COSMETIC, 8 SUBSTANTIVE, 1 A-ONLY (conditional),
1 B-ONLY.

## Empirical results (shared fixtures × both graders)

Three fixtures under `pi-sandbox/.pi/scratch/comparison/fixtures/`:

- **fixture-correct.ts** (~60 lines) — minimal recon with every anchor satisfied.
- **fixture-writer-as-recon.ts** — verbatim copy of `pi-sandbox/.pi/extensions/deferred-writer.ts` (304 lines). Recon profile graded against writer code.
- **fixture-edge.ts** — recon with (a) `Buffer.byteLength` mentioned only in a comment (no call), (b) exactly 3 notify calls.

Runs: `SKIP_LOAD=1 SKIP_BEH=1 <grader> <log> test-model`. Raw outputs at `pi-sandbox/.pi/scratch/comparison/runs/<fixture>/{A,B}/{grade.json,output.md}`.

| Fixture | A P0 | A P1 | B P0 | B P1 | A-only misses | B-only misses |
|---|---|---|---|---|---|---|
| correct | 15/15 | 2/2 | 15/15 | 3/3 | — | — |
| writer-as-recon | 12/15 | 2/2 | 11/15 | 3/3 | — | `no writer-shape harvest` |
| edge | 14/15 | 1/2 | 15/15 | 3/3 | `bounded output` P0, `notifies ≥4` P1 | — |

Shared misses on writer-as-recon (both catch): `--tools allowlist`,
`no ctx.ui.confirm`, `no fs.writeFileSync outside scratch`.

Three empirically-validated substantive divergences (rows in the table that
actually produced different verdicts on the fixtures):

1. **Anchor 19 (writer-shape harvest)** — B correctly identifies writer harvest patterns (`e.args.path`, `inputObj.content`, `= e.args`, etc.) as a P0 violation. A has an equivalent check (`grade-recon.sh:302`) but it only looks for the literal `toolCall.input`, which the reference writer does not use — so A's warning fires on zero real-world writer code. B's regex covers the writer's actual destructuring patterns, including the `inputObj = e.args` idiom from the reference implementation. B is more discriminating on this class of miss in practice.
2. **Anchor 16 (bounded output)** — B passes spuriously on the edge fixture because its substring grep `"Buffer.byteLength"` matches the comment text (`// NOTE: would normally bound with Buffer.byteLength here`). A's regex `Buffer\.byteLength\(` correctly requires the call. B is also one priority level lower (P1 vs A's P0), so even when it fires, a miss costs less. Compound bug.
3. **Anchor 18 (notify threshold)** — With 3 notify calls, A fails `≥4`, B passes `≥2`. Both thresholds are defensible (A inherited writer's 4-phase expectation; B relaxed to 2 for recon's simpler shape). The real bug is the comment-collision risk Track A's own fixture surfaced (the fixture's comment originally contained `ctx.ui.notify`, pushing both graders' substring counts up by 1). Both graders share this `grep -F`-level bug on the notify anchor.

## Core-rails extraction (validated)

The 10 anchors classified IDENTICAL or COSMETIC (table rows 1, 3, 5, 6,
8, 9, 10, 11, 14, 17) are the empirically-shared rails between the two
graders. 7 of them (3, 5, 6, 8, 9, 10, 11) live in Track B's
`lib/core-rails.sh` — the subprocess rails plus `registerCommand`. The
other 3 (1 "Extension file produced", 14 "no ctx.ui.confirm", 17
"--thinking off + --no-session") are in `profiles/recon.sh` because
they're profile-local semantically: writer expects a child-tool file,
so "extension file produced" is not a universal check; writer REQUIRES
`ctx.ui.confirm`, so the negative anchor only makes sense inside recon.
In Track A they're all inlined in `grade-recon.sh:140-362`.

Empirical core-rails line counts (the anchors where A and B agree on both
check and verdict):

| Layer | Track A LoC (inlined) | Track B LoC (dedicated) |
|---|---|---|
| 10 shared anchors (checks only, pass/fail bullets) | ~65 lines scattered across `grade-recon.sh` | ~45 lines in `core-rails.sh:21-90` + `harness.sh:mark_p0/p1` helpers |
| Harness plumbing (`mark_p0`, counters, blob builders, `discover_artifacts`, `classify_strays`) | ~80 lines duplicated between `grade-recon.sh` and `grade-deferred-writer.sh` | ~140 lines in `lib/harness.sh`, reused across profiles |

Takeaway: the 10 IDENTICAL/COSMETIC anchors are cleanly extractable as
Track B already factors them. This validates the core-rails hypothesis
from the root plan — the rails are real, not wishful decomposition.

## Actions before Track A deletion

Track B's recon profile has ONE regression (with two fix components)
and one documented design disagreement relative to Track A. The
regression must land before Track A is removed (per root plan:
"the other is deleted, not kept as dead code"):

1. **Elevate `bounded output` to P0** in `profiles/recon.sh:149` — change `mark_p1` to `mark_p0`. This matches A's priority and `defaults.md` line 217 ("~20 KB") treating bounded output as core recon discipline, not polish.
2. **Tighten `bounded output` regex** — replace `grep_any "Buffer.byteLength"` with `grep_any_ere 'Buffer\.byteLength\('`. This matches A's regex and eliminates the comment-collision bug the edge fixture exposed.
3. **(Judgment call) notify threshold `≥4`** — B's author DOES document the ≥2 rationale inline (`profiles/recon.sh:165-167`: "Recon typically notifies 2–3 times... writer's ≥4 would over-score a profile with fewer phase boundaries"). Whether to adopt A's stricter bar is a genuine design disagreement, not a clear regression. Recommendation: leave B at ≥2, since recon *should* have fewer notify phases than writer and A inherited the 4 unchanged from writer without re-examining it.

Changes 1 and 2 are ~2 lines total in `profiles/recon.sh`.

A separate bug that both graders share (and neither fixture accidentally
caught before the comment-rewrite): the notify anchor uses substring
matching, so a comment containing `ctx.ui.notify` inflates the count. A
follow-up should replace it with a function-call regex on both sides —
but that's grader hygiene, not a comparison-deciding issue.

## Carve-outs (what this comparison cannot say)

- **No live model calls.** Plan steps 3 and 5 (`rebuild-recon.sh -r smoke-{a,b}` across `$AGENT_BUILDER_TARGETS`) are deferred — they need `OPENROUTER_API_KEY` and runtime budget. A per-anchor equivalence check on real model output could surface additional divergences this static comparison missed, especially around ambiguous model output that hits the `SUBSTANTIVE` check code paths from different angles.
- **Linear-scaling claim (~50 lines per new task) stays unfalsifiable.** Root plan defers the orchestrator profile. Track B scaffolding is 726 lines shared + 312 per-profile for recon; a third profile is required to measure whether the marginal-cost curve actually flattens or whether each new profile keeps adding ~300 lines. This comparison covers TWO profiles, not three, so the claim can neither be confirmed nor refuted here.
- **Equivalence by per-anchor verdict, not integer `p0_passed`.** As Track A's takeaways predicted, the `p0_passed` integer is unusable as a comparison key — the denominators differ (15/15 both graders but via different anchor sets, with 3 core-rails anchors in B that don't fire on recon, 1 A-ONLY conditional, 1 B-ONLY active). The diff-by-label approach used above is the only soundly interpretable comparison.

## Files touched

- `scripts/approach-comparison.md` (this file) — new, on branch `claude/composable-rubric-framework-A0vS3`.
- `pi-sandbox/.pi/scratch/comparison/` — fixtures + raw grade outputs, gitignored (scratch).
- `/tmp/compare/{trackA,trackB}/` — extracted graders, ephemeral.

No changes to either track's code. Follow-up PR against Track B for the
three actions above, then a second PR to delete
`scripts/approach-a-monolithic/` once Track B is regression-clean.
