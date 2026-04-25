# 40 — Components carry both sides (Phase 2)

**Gated on Phase 1 green.** Only start once `pi-agent-composer` has
sustained green across all three `$AGENT_BUILDER_TARGETS` on at least
five composer tasks, with GLM 5.1 cost/turns in or near the
assembler's $0.013–$0.048 per-task, 3–6-turn band.

## Intent

Today components ship only the child-side stub tool. The ~80-line
spawn/NDJSON-parse/harvest/promote boilerplate is re-authored in every
`.pi/extensions/<agent>.ts`. This is the single biggest author burden
for the composer skill — and for every model that writes against it.

Growing each component to export a **`parentSide`** surface (harvester,
tools contribution, spawn-args contribution, finalize behavior) lets a
small `delegate()` runtime compose them, collapsing simple agents from
~200 lines to ~15.

## 2.1 Grow `parentSide` on each component

`pi-sandbox/.pi/components/<name>.ts` gains a named export alongside
its default-export factory:

```ts
export const parentSide: ParentSide = {
  tools: ["stage_write"],           // contributes to child --tools CSV
  spawnArgs: ["-e", STAGE_WRITE],   // contributes to child -e flags
  env: {},                           // contributes to child env
  harvest: (event, state) => { /* called per NDJSON event */ },
  finalize: async (state, ctx) => { /* called after child exits */ },
};
```

Per-component contributions:

- **cwd-guard**: `{tools: ["read","sandbox_write","sandbox_edit","ls","grep"], spawnArgs: ["-e", GUARD], env: {PI_SANDBOX_ROOT: cwd}, harvest: noop, finalize: noop}`.
- **stage-write**: `{tools: ["stage_write"], harvest: collectStaged, finalize: confirmThenPromote}`. Extracts `{path, content}` on `tool_execution_start` events where `toolName === "stage_write"`; finalize reads the sibling `review` component state if present (defers to the LLM verdict map) and otherwise prompts `ctx.ui.confirm`, then `fs.writeFileSync` with sha256 verify. This is the code-level manifestation of the `rails.md` §10 predicate (confirm iff `stage-write ∈ components && review ∉ components`).
- **emit-summary**: `{tools: ["emit_summary"], harvest: collectSummaries, finalize: persistToScratchOrReturnBrief}`. Configurable finalize: either write each summary to `.pi/scratch/<title>.md` (recon shape) or return concatenated brief with byte cap (scout shape).
- **review**: `{tools: ["review"], harvest: collectVerdicts, finalize: returnVerdictMap}`. Used by the orchestrator runtime; not normally active in a single-spawn composer agent.
- **run-deferred-writer**: `{tools: ["run_deferred_writer"], harvest: collectDispatchRequests, finalize: returnDispatchList}`. Used by the orchestrator runtime to trigger `Promise.all` fan-out.

Shape of `ParentSide` lives in a new module
`pi-sandbox/.pi/components/_parent-side.ts` (leading underscore to
mark it non-loadable by pi's auto-discovery). Exports the interface
and the generic `state` types.

## 2.2 Ship `delegate()` runtime

`pi-sandbox/.pi/lib/delegate.ts` — a generic parent-side runtime (lives
under `lib/` per `60-open-questions.md §5`, not `components/`, to
signal "library, not auto-loaded artifact"). Signature:

```ts
export async function delegate(ctx: HandlerContext, opts: {
  components: ParentSide[];      // required — the whole point
  prompt: string;                // required — the ask
  model?: string;                // optional; default inferred from components (see below)
  extraTools?: string[];         // optional; rarely used
}): Promise<DelegateResult>;
```

Two required keys, two optional. Everything else is a rail with a
sensible default baked into `delegate()`:

- `timeoutMs`: `PHASE_TIMEOUT_MS = 120_000` — module-level const.
  Every caller in the canonical extensions passes the same value
  today; it is not a per-call parameter, it is a rail.
- `mode`: always `"json"`. `"rpc"` is orchestrator-only and the
  orchestrator stays bespoke (see end of this section), so
  `delegate()` never needs it. No `mode` parameter.
- `cwd`: `process.cwd()`. The only time a caller wants a different
  cwd is the per-run isolation in `agent-maker.sh`, which already
  sets `process.chdir()` before loading extensions.
- `model`: default = role inference from component set, per the
  `AGENTS.md` tier rule. If `review ∈ components ||
  run-deferred-writer ∈ components`, use `$LEAD_MODEL`; else
  `$TASK_MODEL`. Caller can override by passing `model` explicitly.
  This turns "match the tier to the child's role" from a per-agent
  obligation into a library default.

Escape hatch: pass `model` to override tier inference. There is no
escape hatch for `timeoutMs`/`mode`/`cwd` by design — if you need
one, you are writing something `delegate()` doesn't cover and should
drop to bespoke spawn code (like the RPC orchestrator below).

Internals:

- Unions `opts.components[].tools` + `opts.extraTools` for `--tools`.
- Concatenates `opts.components[].spawnArgs` for `-e` flags.
- Merges `opts.components[].env` into child env (`PI_SANDBOX_ROOT`
  from `cwd-guard.env` lands here).
- Applies every rail from `rails.md` (§1–9, 12): SIGKILL timer, NDJSON
  loop, `--no-extensions`, cost extraction, path validation on any
  promoted writes.
- Dispatches each NDJSON event to every component's `harvest()`.
- On child close, invokes each component's `finalize()` in sequence.
- Returns aggregated `DelegateResult` (staged writes, summaries,
  verdicts, dispatch requests, total cost, exit status).

`delegate()` covers `single-spawn` and
`sequential-phases-with-brief` (caller invokes twice, passes brief
into second prompt). `rpc-delegator-over-concurrent-drafters` stays
bespoke — the orchestrator authors its own dispatch→review loop but
imports per-component harvesters from `parentSide` instead of
re-implementing them.

Resulting thin-agent call (Phase 2.4) collapses to two keys:

```ts
await delegate(ctx, {
  components: [CWD_GUARD, STAGE_WRITE],
  prompt: args,
});
```

## 2.3 Refactor canonical extensions onto `delegate()`

**Validates the abstraction against real code before the composer
starts emitting it.** Land `deferred-writer.ts` first; only then
re-estimate the orchestrator target.

- `pi-sandbox/.pi/extensions/deferred-writer.ts`:
  - Before: 316 lines of spawn + NDJSON + confirm + promote.
  - After: ~15 lines — single `delegate()` call with `[CWD_GUARD,
    STAGE_WRITE]`, prompt from slash-command args, confirm gate
    wired in `stage-write.finalize` per §2.1.
  - **Gate:** if the LOC reduction is less than 5× (i.e. the refactor
    ends up >60 lines), stop and reconsider `delegate()`'s shape
    before touching the orchestrator. The schema is wrong if a
    known-good extension doesn't collapse cleanly.
- `pi-sandbox/.pi/extensions/delegated-writer.ts`:
  - Before: **701 lines** (dispatch → review → revise RPC loop,
    per-drafter dashboard, cost aggregation, feedback map).
  - After: measure after `deferred-writer.ts` lands — apply the same
    reduction *ratio* to the non-RPC-loop portion (drafter spawns,
    per-event harvest, promotion) and keep the RPC
    dispatch→review→revise loop custom. Earlier drafts quoted a
    specific target line count, but the real figure depends on what
    `delegate()` reclaims from the drafter-spawn path, which won't
    be known until 2.3 step 1.
  - Required behaviors preserved: drafter spawns inside `Promise.all`
    delegate to `delegate()`; review-verdict parsing uses
    `REVIEW.parentSide.harvest`; dispatch-list harvest uses
    `RUN_DEFERRED_WRITER.parentSide.harvest`.

Both refactors must pass their existing probe tasks
(`deferred-writer` and any orchestrator task we add in Phase 1.6)
byte-equivalently — no user-visible behavior change.

## 2.4 Composer emits thin agents

Once `delegate()` exists and canonical extensions validate it:

- `procedure.md` step 4 ("wire it") emits ~10-line TS files calling
  `delegate({components: [...], prompt})` instead of inline
  spawn/NDJSON code. The two-key signature from §2.2 is what lets
  the body be this short — earlier "~15 lines" estimates assumed the
  7-key signature that R20 trimmed.
- Per-part `parts/*.md` "Parent-side wiring template" sections
  collapse to a single line per part: "adds `parentSide` to
  `delegate()` call — see `_parent-side.ts`." This dramatically
  shrinks the skill's prompt surface, which is the point.
- `compositions.md` `single-spawn` and
  `sequential-phases-with-brief` rows drop their canonical-extension
  pointers in favor of a `delegate()` usage snippet.
  `rpc-delegator-over-concurrent-drafters` still points at
  `delegated-writer.ts`.

## 2.5 Grader exploits thin agents

Once agents are thin:

- `component-spec.ts` `wiringChecks` can check for a `delegate({components: [...]})`
  call with the expected component imports — an AST-free regex walk
  over `extBlob`. Far simpler than today's per-anchor validation.
- Fallback: if the produced agent doesn't use `delegate()` (custom
  RPC loop), fall back to today's per-component regex anchors.
- Add a P1 mark "uses-delegate" to reward thin agents; not required
  for pass.

## Risks & mitigations

- **`delegate()` config schema gets locked in too early.** Mitigation:
  Phase 2 starts from validated canonical-extension refactors, not
  from a green-field schema design. If two canonicals refactor
  cleanly, the schema is likely right.
- **`parentSide` surface proliferation.** If every new component needs
  a different `harvest` signature, the interface becomes a union
  type. Mitigation: keep `harvest` signature as generic
  `(event, state)` and push specifics into the `state` shape per
  component.
- **Breaks the `pi-agent-assembler`-produced agents.** Agents already
  written against the current (child-side only) components must keep
  working. Mitigation: `parentSide` is an *additional* named export;
  the default-export factory and child-side tool registration do not
  change. Old agents ignore `parentSide` and behave as today.
- **Skill prompt token budget.** Adding `parentSide` docs to
  `parts/*.md` bloats the composer's prompt. Mitigation: Phase 2.4
  *shrinks* the per-part wiring templates — net prompt size drops.

## Verification

- `delegate()` unit tests — fixture NDJSON stream → expected state
  evolution per component. Lives at
  `pi-sandbox/.pi/components/__tests__/delegate.test.ts`.
- Canonical-extension regression: `/deferred-writer` and
  `/delegated-writer` slash commands produce byte-identical
  promoted files on a probe invocation before/after refactor.
- Composer baseline re-run: all Phase-1 composer tasks still green,
  now with "uses-delegate" P1 mark attached.
- Cost regression: thin agents should *improve* small-model
  cost/turns; if any cell regresses, investigate before widening.
