# 20 — Composer grader module (Phase 1b)

New grader alongside `scripts/grader/graders/assembler.ts`. Dispatch
chooses between the two based on `spec.skill`.

## New files

### `scripts/grader/lib/component-spec.ts`

Per-component wiring-check registry. Exports:

```
interface ComponentSpec {
  name: "cwd-guard" | "stage-write" | "emit-summary" | "review" | "run-deferred-writer";
  filename: string;                    // "cwd-guard.ts", etc.
  toolsContribution: string[];         // what --tools allowlist this part requires
  spawnArgsContribution: string[];     // -e <abs path>
  envContribution: string[];           // env var names the child must see
  wiringChecks: (art: ArtifactSet, spawns: SpawnInvocation[]) => Mark[];
}

export const COMPONENTS: Record<string, ComponentSpec>;
```

Per-component `wiringChecks`:

- **cwd-guard**: `PI_SANDBOX_ROOT` in at least one spawn's env + `-e <...cwd-guard.ts>` on every write-capable spawn.
- **stage-write**: extBlob contains `tool_execution_start` + `"stage_write"` + `ctx.ui.confirm` + `fs.writeFileSync` + `sha256` (ignore case for the last).
- **emit-summary**: extBlob contains `tool_execution_start` + `"emit_summary"` + (`Buffer.byteLength` OR `.slice(0,`) + optional `.pi/scratch/` write. If `stage-write` not in component list, confirm `ctx.ui.confirm` is absent.
- **review**: any spawn has `--mode rpc` and `--tools` includes `review`.
- **run-deferred-writer**: any spawn has `--tools` includes `run_deferred_writer`; extBlob contains `Promise.all` (concurrent dispatch).

All regex anchors already exist in the current `applyPerPatternChecks`
(`scripts/grader/graders/assembler.ts:294-442`); this file re-homes
them per-component instead of per-pattern.

### `scripts/grader/graders/composer.ts`

Structure parallels `assembler.ts`. Entry: `gradeComposerTask(spec,
runDir, artifacts, rubric)`. Dispatch by `spec.expectation.kind`:

- `"composition"` (new kind, analogous to assembler's `"assembly"`) →
  run:
  1. **Structural checks** (extension exists under `.pi/extensions/`,
     command registered, no strays) — same as assembler's
     `gradeStructural`; factor into a shared helper in
     `scripts/grader/lib/core-rails.ts` if not already there.
  2. **Composition fidelity** — parse all `spawn("pi", ...)` calls
     via `findSpawnInvocations`. For each expected component, verify
     (a) its `spawnArgsContribution` appears in at least one spawn's
     args, (b) union of `toolsContribution` ⊆ spawn's `--tools` CSV,
     (c) no forbidden tool (`write`, `edit`, `bash`). P0 on (a),
     (b), (c); P1 on no-unexpected-components.
  3. **Per-component wiring** — iterate `expectation.components`,
     invoke each spec's `wiringChecks`, merge marks.
  4. **Composition-topology check** — if `expectation.composition` is
     set, assert the appropriate anchor: `single-spawn` = exactly one
     `spawn("pi"`; `sequential-phases-with-brief` = ≥2 spawns with
     a brief assembly (`Buffer.byteLength` between spawns);
     `rpc-delegator-over-concurrent-drafters` = one `--mode rpc`
     spawn + `Promise.all` + inner drafter spawn(s). If
     `composition` omitted, infer from component list (see
     `60-open-questions.md` §2) and emit a P1 warning that it's
     implicit.
  5. **Probes** (load + behavioral) — unchanged; mode pick becomes
     "recon if `emit-summary ∈ components && stage-write ∉ components
     && cwd-guard ∉ components`".
- `"gap"` → GAP header regex identical to assembler's; P0 no artifacts
  + `GAP` in final message + `I don't have a component`.

### `scripts/grader/__tests__/component-spec.test.ts`

New tests mirroring `pattern-spec.test.ts`'s structure, but focused on:

- Each `COMPONENTS[name].wiringChecks` returns expected Mark shape on
  a fixture spawn+extBlob.
- Forbidden-tool rejection.
- Mode inference (composition topology from component set).

Keep `pattern-spec.test.ts` as-is — it tests the assembler path which
is unchanged.

## Modified files

### `scripts/grader/lib/test-spec.ts`

Additive changes only:

- Extend `skill` enum: add `"pi-agent-composer"` to existing
  `"pi-agent-assembler" | "pi-agent-builder"`.
- Add discriminated union member for composer tasks:

  ```
  // New
  export const CompositionExpectation = z.object({
    kind: z.literal("composition"),
    components: z.array(ComponentNameEnum).min(1),
    composition: z.enum([
      "single-spawn",
      "sequential-phases-with-brief",
      "rpc-delegator-over-concurrent-drafters",
    ]).optional(),
    extra_tools: z.array(z.string()).optional(),
  });

  export const GapExpectation = z.object({ kind: z.literal("gap"), closest_match: z.string().optional() });

  // Expectation schema becomes a discriminated union over kind.
  ```

- `AssemblyExpectation` (the assembler's schema) stays byte-identical.
  This is the key point: the assembler contract never changes.

### `scripts/grader/index.ts`

Dispatch on `spec.skill`:

```
if (spec.skill === "pi-agent-assembler") return gradeAssemblerTask(...);
if (spec.skill === "pi-agent-composer")  return gradeComposerTask(...);
// builder path unchanged
```

### `scripts/grader/lib/rubric.ts`

No change expected; Mark shape is skill-agnostic. Add a note in the
composer grader header referencing which rail number each mark
corresponds to (rails.md §1–12), for easier debugging.

## Unchanged (explicitly)

- `scripts/grader/graders/assembler.ts`
- `scripts/grader/lib/pattern-spec.ts`
- `scripts/grader/__tests__/pattern-spec.test.ts`
- `scripts/grader/lib/{core-rails,probes,artifact}.ts` — component-
  agnostic utilities reused by both graders.

## Verification

- `npx tsx --test scripts/grader/__tests__/*.test.ts` — both
  `pattern-spec.test.ts` and `component-spec.test.ts` green.
- Dry-run with a hand-authored fixture: call `gradeComposerTask` on
  `pi-sandbox/.pi/extensions/deferred-writer.ts` under a synthetic
  `CompositionExpectation` with `components: [cwd-guard, stage-write]`
  + `composition: single-spawn`. Expect full pass — this validates the
  grader against a known-good implementation before it sees any
  composer-produced extension.
