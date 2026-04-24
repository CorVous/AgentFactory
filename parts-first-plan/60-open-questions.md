# 60 — Open questions

Track decisions deferred to implementation. Answer each with a dated
note as it lands.

## 1. Should `compositions.md` exist, or can per-part docs cover it?

**Recommendation:** keep `compositions.md`. The
`rpc-delegator-over-concurrent-drafters` shape is cross-part — it
touches `review`, `run-deferred-writer`, `cwd-guard`, and
`stage-write` simultaneously, and none of those per-part docs is the
right place to describe "persistent RPC conversation across phases."
The two simpler topologies (`single-spawn`,
`sequential-phases-with-brief`) could collapse into per-part wiring
hints, but keeping all three in one doc is cheap (~80 lines) and
gives the skill a named-shape vocabulary small models latch onto.

**Status:** provisionally yes. Revisit after first composer round.

**Status (2026-04-24): decided — yes.** `compositions.md` exists at
`pi-sandbox/skills/pi-agent-composer/compositions.md`. Phase-1 round
evidence (`baselines/phase2-gate/`) shows small models successfully
navigate the three-shape vocabulary.

## 2. Auto-infer `composition` from component list?

This is the **source of truth** for the inference cascade; the grader
(`20-composer-grader.md §Composition-topology check`) mirrors it.

```
composition-inference (when expectation.composition is omitted):
  if run-deferred-writer ∈ components        → rpc-delegator-over-concurrent-drafters
  else if review ∈ components                → rpc-delegator-over-concurrent-drafters
  else if emit-summary ∈ components && stage-write ∈ components
                                             → sequential-phases-with-brief
  else                                       → single-spawn
```

Ordering matters: the `review ∈ components` branch fires **before**
the `emit-summary + stage-write` branch. Without that precedence,
`composer-review-only` (`[cwd-guard, stage-write, review]`) would
never have triggered `sequential-phases-with-brief` — but tasks like
`composer-scout-then-draft` (`[cwd-guard, emit-summary, stage-write]`
plus *nothing else*) need the emit-summary+stage-write branch to fire
on their own. The ordered cascade separates the two cleanly.

**Recommendation:** make `composition:` optional in `test.yaml`;
auto-infer with a P1 warning when it's load-bearing but omitted. This
reduces author burden on simple tasks while keeping the explicit
override for edge cases.

**Status:** provisionally yes. Implement in `component-spec.ts`'s
inference helper; emit the warning in grader output.

**Status (2026-04-24): decided — yes.** Implemented at
`scripts/grader/lib/test-spec.ts::inferComposition`. Cascade matches the
pseudocode above (review branch precedes emit+stage branch) and is
covered by `scripts/grader/__tests__/component-spec.test.ts` (four cases).

## 3. Should `composer-*` task prompts mirror assembler task prompts
   byte-for-byte?

For the four mirror tasks, identical prompts make the A/B a clean
read: same ask, different skill, compare results. If we reword the
prompts to be "more composer-idiomatic," we conflate skill differences
with prompt differences.

**Recommendation:** byte-identical prompts for mirror tasks. Net-new
tasks (`composer-review-only`, `composer-full-orchestrator`) get
fresh prompts tuned to their composition shape.

**Status:** provisionally yes.

**Status (2026-04-24): decided — yes.** Spot-verified: `composer-recon`
and `recon-agent` prompts match byte-for-byte, same for
`composer-scout-then-draft` / `scout-then-draft-agent`. All four mirror
tasks use identical prompts to their assembler counterparts.

## 4. Where do `signal-map.ts` rows live — source of truth?

The prompt validator (§30) needs a machine-readable version of
`reading-short-prompts.md`'s 30-row signal table. Two options:

- (a) hand-mirror in `scripts/grader/lib/signal-map.ts` — fast to
  implement, drifts over time.
- (b) auto-generate from the markdown at build time — zero drift,
  needs a small parser.

**Recommendation:** write the markdown parser first — the
`prompts-signal-drift.test.ts` drift test needs it either way. If
the parser fits in under 40 lines, use it to auto-generate
`signal-map.ts` at build time directly (option b) and skip the
hand-mirror. If the parser needs more than 40 lines, keep a
hand-mirrored `signal-map.ts` and use the parser only for the drift
test (option a). The choice is driven by parser cost, not an upfront
preference.

**Status:** parser-size-driven. Revisit once the parser is written.

**Status (2026-04-24): option (a) chosen — hand-mirrored + drift test.**
`scripts/grader/lib/signal-map.ts` remains the hand-mirrored source of
truth for `validate-prompt.ts`; drift is guarded by a new test at
`scripts/grader/__tests__/prompts-signal-drift.test.ts` that parses the
markdown table in `reading-short-prompts.md` and compares row-by-row. No
build-time codegen step introduced.

## 5. Does `delegate()` belong in `pi-sandbox/.pi/components/` or
   somewhere else?

`components/` is for child-side stubs that get loaded into child pi
processes via `-e`. `delegate()` is a **parent-side** helper
imported by extensions. Putting it in `components/` is a mild
semantic abuse.

**Candidates:**

- `pi-sandbox/.pi/components/delegate.ts` — convenient, mildly wrong.
- `pi-sandbox/.pi/lib/delegate.ts` — cleaner, new dir.
- `pi-sandbox/.pi/extensions/_delegate.ts` — underscore-prefixed so
  pi's auto-discovery skips it; same tree as the canonical
  extensions that import it.

**Recommendation:** `pi-sandbox/.pi/lib/delegate.ts`. New dir is one
line in `.gitignore` review and signals "this is a library, not an
auto-loaded artifact." The `_parent-side.ts` type module goes there
too.

**Status:** defer until Phase 2 is about to land.

**Status (2026-04-24): decided — `pi-sandbox/.pi/lib/delegate.ts`.** File
lives where the recommendation placed it. The sibling type module
`_parent-side.ts` went to `pi-sandbox/.pi/components/_parent-side.ts`
rather than `lib/` — the underscore already keeps it out of
auto-discovery, and co-locating with the components that import it
reduced the Phase 2.1 diff. Not worth relocating now.

## 6. Orchestrator task in Phase 1?

Phase 1 originally planned `composer-full-orchestrator` as a net-new
task. But orchestrator is the highest-complexity shape and the most
likely to regress on small models — and pre-`delegate()`, composer
emits the full RPC orchestrator inline (~700 lines mirroring
`delegated-writer.ts`), which risks masking wins on simpler
compositions.

**Recommendation:** move to Phase 1.6 (see `30-composer-tasks.md`
bottom). Gate: mirror tasks (1a/1b/1c) sustain green on ≥2/3 models
across ≥1 full round before orchestrator is authored. Phase 2 does
not gate on Phase 1.6; if GLM fails orchestrator specifically, that
remains a known small-model ceiling (like recon behavioral=partial on
deepseek-v3.2 in `AGENTS.md`).

**Status:** decided — Phase 1.6, not Phase 1.

**Status (2026-04-24): landing.** Mirror-task gate met per
`baselines/phase2-gate/README.md` (2-of-3-green across all five tasks).
`composer-full-orchestrator/test.yaml` ships in the same landing as this
hygiene pass; initial baseline cells captured in
`baselines/phase2-delegate-v2/`.

## 7. Should `pi-agent-composer` link into
   `pi-agent-builder/references/defaults.md`?

Assembler cross-links into the builder's defaults.md via procedure.md
notes ("pattern skeletons encode the always-on rails from …"). The
composer's `rails.md` will cite `defaults.md` sections directly.
Question: should the builder's `defaults.md` also *back-link* into
the composer (add a "See also: pi-agent-composer/rails.md" note)?

**Recommendation:** no back-link from builder in Phase 1. The builder
is the reference surface; it doesn't need to know about the composer
to stay useful. Add a back-link only if composer becomes the default
sub-agent skill (post-Phase-2 decision).

**Status:** provisionally no.

## 8. Rename `agent-maker` for composer-first workflows?

`scripts/task-runner/agent-maker.sh` has `pi-agent-builder` as the
default `-s`. If composer becomes the preferred skill, we'd flip the
default. But that affects every invocation in AGENTS.md and npm
scripts.

**Recommendation:** do not change the default in Phase 1. Document
composer invocation as `-s pi-agent-composer`; evaluate the default
flip only if Phase 2 lands green.

**Status:** provisionally no change.

## 9. Should Phase 2's `parentSide` be tagged-union or open record?

Tagged-union (discriminated on `type: "stage-write"`, etc.) is
type-safe but adds boilerplate every new component. Open record
(`Record<string, unknown>` state) is flexible but loses compile-time
checks on `harvest`.

**Recommendation:** tagged-union. The component set is small (5
today, maybe 10 in 18 months); discriminator overhead is worth it
for the type safety downstream in `delegate()`.

**Status:** defer to Phase 2 implementation; revisit if grader tests
force open-record.

**Status (2026-04-24): decided — neither tagged-union nor single open
record; per-component generics.** `_parent-side.ts` ships
`ParentSide<State, Result>` with each component instantiating its own
concrete `State`/`Result` types (`StageWriteState`, `EmitSummaryState`,
`ReviewState`, `DispatchRequestsState`, `CwdGuardState`). The
`delegate()` runtime treats states as `unknown` internally and leaves
per-component `harvest`/`finalize` type-safe at their own call sites. No
discriminator overhead, full compile-time checking downstream.
