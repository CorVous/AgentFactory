# 10 — Composer skill layout (Phase 1a)

Net-new skill at `pi-sandbox/skills/pi-agent-composer/`. No changes to
`pi-agent-assembler/` in this phase.

## File tree

```
pi-sandbox/skills/pi-agent-composer/
├── SKILL.md
├── procedure.md
├── rails.md
├── compositions.md
└── parts/
    ├── cwd-guard.md
    ├── stage-write.md
    ├── emit-summary.md
    ├── review.md
    └── run-deferred-writer.md
```

## SKILL.md

Frontmatter:

- `name: pi-agent-composer`
- `description:` — triggers on `compose pi agent`, `parts-first`,
  `component-driven`, component names (`cwd-guard`, `stage-write`,
  `emit-summary`, `review`, `run-deferred-writer`), phrases like
  "build a pi agent that uses X", "pi extension with component Y". Do
  NOT list the five pattern names — that's the assembler's trigger
  surface.

Body sections:

1. **Cardinal rules** (3, not 4):
   - Compose, don't author. Parts in `pi-sandbox/.pi/components/` are
     the vocabulary. Do not invent new child-tools or NDJSON
     harvesters.
   - `cwd-guard.ts` is required on every write-capable sub-pi spawn.
     Sole exception: a read-only child whose only write channel is
     `emit_summary` (no filesystem contact).
   - Output under `.pi/extensions/<name>.ts`. Never the cwd root.
2. **Parts catalog** — table of the five components (`parts/*.md` per-part
   docs). Includes `run-deferred-writer`, promoted from
   assembler-inline.
3. **Compositions catalog** — three-row table citing `compositions.md`:
   `single-spawn`, `sequential-phases-with-brief`,
   `rpc-delegator-over-concurrent-drafters`.
4. **Always-on rails** — one-liner pointing at `rails.md`.
5. **Naming conventions** — `stage_*` / `emit_*` / role-name taxonomy
   (copy-paste from assembler, still accurate).
6. **Anti-patterns** — (a) inventing new parts, (b) skipping cwd-guard
   on write-capable children, (c) skipping the `rails.md` checklist,
   (d) mixing composition topologies in one handler.
7. **When to fall back to `pi-agent-builder`** — same as assembler's
   fallback section; point at builder's references.

Not shipped: `prompts-seen.md`. That file is assembler-specific (logs
pattern-name asks seen in the wild). The composer's signal surface is
inherited from
`pi-sandbox/skills/pi-agent-builder/references/reading-short-prompts.md`,
which is already load-bearing for the prompt validator (§30). No
composer-local mirror.

## procedure.md

Five-step flow:

1. **Read signals.** Reuse
   `pi-sandbox/skills/pi-agent-builder/references/reading-short-prompts.md`'s
   30-row table. Each signal implies one or more components.
2. **Pick parts.** Enumerate the parts the signals point at. Note
   that `cwd-guard` is implicit whenever any write-capable part
   (`stage-write`, `sandbox_write` via a drafter child) is in the set.
3. **Pick composition topology.** `compositions.md` names three:
   - One child, one phase → `single-spawn`.
   - Two or more children run serially, parent assembles a brief
     between phases → `sequential-phases-with-brief`.
   - Persistent delegator LLM over concurrent drafter fan-out + LLM
     review loop → `rpc-delegator-over-concurrent-drafters`.
   If nothing fits → step 5.
4. **Wire it.** Follow each selected part's "Parent-side wiring
   template" (in `parts/<name>.md`) and apply every rail in `rails.md`.
5. **GAP.** If step 1/2/3 produces no confident match, emit the exact
   literal:

   ```
   GAP: I don't have a component for "<user's ask, quoted>".
   Components I have: cwd-guard, stage-write, emit-summary, review, run-deferred-writer.
   Closest match: <"none" OR nearest part/topology + 1-sentence why>.
   To cover this you'd need: <one sentence describing the missing part>.
   To continue anyway, load the pi-agent-builder skill.
   ```

   The `GAP:` header + `I don't have a component` phrase must match the
   regex at `scripts/grader/graders/composer.ts`'s GAP check — same
   literal the assembler uses so graders share the regex.

## rails.md

Load-bearing home for the rails that pattern skeletons used to enforce
by-copy. Each bullet is a checklist item the grader can assert;
each cites the corresponding section in
`pi-sandbox/skills/pi-agent-builder/references/defaults.md` rather than
re-prosing the rule.

Bullets (expected count ~12):

1. Spawn frame — `spawn("pi", [...args], { stdio, cwd, env })` with
   `--mode {json|rpc}`, `--no-extensions`, `--no-session`,
   `--thinking off`, `--provider openrouter`, `--model` from
   `process.env.{TASK,LEAD,PLAN}_MODEL` per role.
2. NDJSON line-parse loop — `buffer += d.toString(); lines = buffer.split("\n"); buffer = lines.pop() ?? "";` + per-line `JSON.parse` with try/catch.
3. Timeout — `setTimeout(() => child.kill("SIGKILL"), ms)` + `clearTimeout` on close|error.
4. Cost extraction — `event.message.usage.cost.total` on `message_end`;
   aggregate; surface in final notify.
5. Path validation — reject absolute, reject `..`, `startsWith(sandboxRoot + path.sep)`, exists-check.
6. Promotion — sha256 verify, `MAX_FILES_PROMOTABLE`, `MAX_CONTENT_BYTES_PER_FILE`, `mkdirSync(..., { recursive: true })`.
7. Output path — `.pi/extensions/<name>.ts`, never cwd root.
8. Tool allowlist — union of each selected part's `tools:` contribution;
   no built-in `write`/`edit`/`bash` ever.
9. Sandbox root — `PI_SANDBOX_ROOT` in child env whenever `cwd-guard.ts`
   is loaded.
10. Confirmation gate — `ctx.ui.confirm` before any parent-side
    `fs.writeFileSync`. Required iff `stage-write ∈ components &&
    review ∉ components`; when `review ∈ components` the LLM verdict
    is the gate, no human confirm fires.
11. Dashboard (orchestrator-only) — `ctx.ui.setWidget` + `setStatus` on
    every state mutation; guard against absence.
12. `ctx.ui.notify` — one message per phase boundary (child spawn,
    harvest complete, promotion complete).

## compositions.md

Three topologies. Each entry is ~20 lines:

### single-spawn

- **When:** one child, one phase.
- **Covers:** recon-style (read-only), confined-drafter (writes via
  `sandbox_write`), drafter-with-approval (stages via `stage_write`).
- **Canonical reference:** `pi-sandbox/.pi/extensions/deferred-writer.ts`
  lines 52–128 (child spawn + NDJSON loop) + 278–306 (promotion).
- **Rails that apply:** 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12.

### sequential-phases-with-brief

- **When:** recon phase + drafter phase, parent assembles brief between.
- **Covers:** scout-then-draft.
- **Canonical reference:** no single existing extension — inline this
  worked example until `composer-scout-then-draft` lands and takes
  over as the reference.

  ```
  // Phase 1: scout child (emit-summary only, no write channel)
  const scoutResult = await runChild(/* args with -e emit-summary */);
  const brief = scoutResult.summaries
    .map(s => `## ${s.title}\n${s.body}`)
    .join("\n\n");
  if (Buffer.byteLength(brief, "utf8") > BRIEF_MAX_BYTES) {
    throw new Error("brief exceeds budget");
  }

  // Phase 2: drafter child (shape borrowed from
  // pi-sandbox/.pi/extensions/deferred-writer.ts:52-128 — child spawn
  // + NDJSON loop, plus lines 278-306 — promotion)
  const drafterPrompt = `${args}\n\n<brief>\n${brief}\n</brief>`;
  const drafterResult = await runChild(/* args with -e stage-write, cwd-guard */);
  // ...stage-write.finalize handles confirm + promote as in single-spawn.
  ```

- **Rails that apply:** all of single-spawn + bounded brief size
  (`Buffer.byteLength` check before second spawn).

### rpc-delegator-over-concurrent-drafters

- **When:** persistent RPC delegator LLM dispatches multiple drafters
  and reviews their drafts; LLM is the gate, not a human confirm.
- **Covers:** orchestrator.
- **Canonical reference:** `pi-sandbox/.pi/extensions/delegated-writer.ts`
  lines 270–385 (RPC session), 513–578 (dispatch fan-out), 623–666
  (review + feedback map).
- **Rails that apply:** all single-spawn rails + rail 11 (dashboard).

No TypeScript in `compositions.md`. Code lives in the canonical
extensions; this file is the jumping-off point.

## parts/*.md — grown with parent-side wiring

Each existing `pi-agent-assembler/parts/<name>.md` gets a near-copy in
the composer tree with one appended section:

### Parent-side wiring template

Concrete, copy-adaptable text with:

- **Event anchor** — exact NDJSON `type + toolName` pair to match.
- **Args destructuring** — shape of `event.input` the parent reads.
- **State shape** — what the parent accumulates across events.
- **Finalize behavior** — what the parent does on child close.

Per component:

- **cwd-guard** — negative wiring case: no parent harvest; child writes
  directly via `sandbox_write`/`sandbox_edit`. Tool allowlist
  contribution: `read, sandbox_write, sandbox_edit, ls, grep`. Env
  contribution: `PI_SANDBOX_ROOT`.
- **stage-write** — harvest `tool_execution_start` + `toolName ===
  "stage_write"`; destructure `{path, content}`; accumulate into
  staged array; finalize = `ctx.ui.confirm` → `fs.writeFileSync` +
  sha256 verify.
- **emit-summary** — harvest `tool_execution_start` + `toolName ===
  "emit_summary"`; destructure `{title, body}`; byte cap per body;
  finalize = concatenate into brief OR persist to
  `.pi/scratch/<title>.md`.
- **review** — harvest `tool_execution_start` + `toolName === "review"`;
  destructure `{file_path, verdict, feedback}`; per-task feedback
  map; finalize = feed approved paths to promotion, revise paths to
  re-dispatch.
- **run-deferred-writer** — harvest `tool_execution_start` + `toolName
  === "run_deferred_writer"`; destructure `{task}`; finalize =
  `Promise.all` of drafter children, one per task.

## Reuse (don't re-prose)

- Every rail bullet cites `pi-agent-builder/references/defaults.md#<section>`.
- Composition references cite canonical extensions by file:line.
- `reading-short-prompts.md` is imported by reference from step 1 of
  `procedure.md`.
