# AgentFactory

Workspace for building and testing **pi agents** using
[`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono). Pi is
installed as a regular npm dependency so the `pi` CLI is available via
`node_modules/.bin/pi`.

## Launching pi

Pi always runs from `pi-sandbox/` — its extensions, sessions, and scratch
files live there. The `npm run pi` script handles the `cd` for you and
also passes `--no-context-files` so the outer `AGENTS.md`/`CLAUDE.md`
(which are *human* docs about this repo) don't leak into pi's context.

- `npm run pi` — interactive pi session in the sandbox.
- `npm run pi -- -p "..."` — non-interactive. Forward any extra pi
  flags after the `--`.
- `npx pi --help` — full flag reference (`-e` for extensions, `--skill`
  for skills, `-p` for non-interactive, `--mode json` for streaming
  events, `-nc` / `--no-context-files` to suppress AGENTS.md/CLAUDE.md).

Dependencies live in `node_modules/` at the repo root; run `npm install`
after cloning. Invoking pi directly (`npx pi`) from the repo root is not
recommended — it runs outside the sandbox and will pick up the outer
docs as context.

## Model tiers

This repo assumes a three-tier agent architecture. The concrete model IDs live
in [`models.env`](./models.env) and are loaded as environment variables. When
wiring a new agent, match the tier to the job:

| Variable | Role | When to use |
| --- | --- | --- |
| `PLAN_MODEL` | Big Planner / Orchestrator | Whole-picture strategy and subtask decomposition. Runs rarely; needs frontier reasoning and long-context coherence. |
| `LEAD_MODEL` | Team Lead / Task Overseer | Reviews worker output, assigns follow-ups, keeps the plan on track. Runs often; solid reasoning but not frontier. |
| `TASK_MODEL` | Code Rabbit / Worker | Bulk task execution. Runs constantly; optimize for cost-per-token at acceptable quality. |

In addition to the three tiers, `models.env` exposes
`AGENT_BUILDER_TARGETS` — a comma-separated list of models the
agent-making skills (`pi-agent-builder`, `pi-agent-assembler`) are
expected to work well on (each skill should produce a correct, safe
pi extension from a short natural-language prompt on every one of
them, not just one). Current targets: **Haiku 4.5**
(`anthropic/claude-haiku-4.5`), **Gemini 3 Flash Preview**
(`google/gemini-3-flash-preview`), and **GLM 5.1** (`z-ai/glm-5.1`).
When refining a skill, test against all three; when invoking pi,
pick any and pass it via `--model`. GLM 5.1 was dropped on
2026-04-23 for the builder skill (too slow, too many turns) and
added back the same day after the smaller assembler skill landed:
on smoke tests across drafter-with-approval / recon / gap tasks,
GLM converged in 3–6 turns at $0.013–$0.048/task with full-pass
grades. The "compose, don't author" shape fits it well.

Source the file before launching pi so the tier vars are in scope:

```sh
set -a; source models.env; set +a
npm run pi -- --model "$TASK_MODEL"    # or $LEAD_MODEL / $PLAN_MODEL
```

`models.env` is committed because the IDs are not secrets. Put API keys in a
gitignored `.env` instead.

## Creating pi agents

Pi ships no sub-agent feature by default. Use pi itself with one of
two bundled skills; they split on "compose vs author":

- **`pi-agent-assembler`** — composes already-tested parts from
  `pi-sandbox/.pi/components/` (cwd-guard, stage-write, review)
  into agents matching one of four patterns: `recon`,
  `drafter-with-approval`, `confined-drafter`, `orchestrator`. If
  the user's request maps to a pattern, this is the faster,
  safer path. If no pattern fits, the skill emits a GAP message
  and stops — that's the signal to fall back to the builder.
- **`pi-agent-builder`** — from-scratch authorship. Use when the
  assembler flagged a gap, or for shapes the assembler doesn't
  cover (custom UI widgets, compaction strategies, event-only
  extensions, context injection, session persistence, pi
  packages).

Pick per-run via `-s <skill-name>` on `agent-maker.sh`. Default is
`pi-agent-builder` for now — shift to assembler-first once it's
settled.

### Invoking the skill

Preferred: `npm run agent-maker` / `npm run agent-maker:i`. Both wrap
`scripts/approach-b-framework/agent-maker.sh`, which runs pi in a
**per-run isolated cwd** under `pi-sandbox/.pi/scratch/runs/<label>/`
with the pi-agent-builder skill loaded at an absolute path, a narrow
`--tools read,sandbox_write,sandbox_edit,ls,grep` allowlist, and the
`cwd-guard.ts` extension that rejects any write/edit outside the run
cwd. The shared `pi-sandbox/.pi/{extensions,components}/` is never
touched, so concurrent invocations don't race.

```sh
# One-shot (task-driven, auto-graded):
npm run agent-maker -- recon-agent -m anthropic/claude-haiku-4.5 --grade

# Same, via the assembler skill (preferred when the task matches
# a documented pattern — recon, drafter-with-approval, etc.):
npm run agent-maker -- recon-agent -m anthropic/claude-haiku-4.5 \
  -s pi-agent-assembler --grade

# Interactive (hands-on skill REPL):
npm run agent-maker:i              # uses $TASK_MODEL
npm run agent-maker:i -- -m google/gemini-3-flash-preview

# Batch across $AGENT_BUILDER_TARGETS (one run per model, sequential):
scripts/approach-b-framework/run-task.sh recon-agent -r my-label
```

Both npm scripts source `models.env` first, so `$TASK_MODEL` etc. are
already in scope.

Legacy ad-hoc path (no isolation, no tool scoping — avoid for batch work):

```sh
set -a; source models.env; set +a
npm run pi -- --provider openrouter --model "$LEAD_MODEL" \
  --skill skills/pi-agent-builder \
  -p "Use the pi-agent-builder skill to <describe the agent>."
```

This runs from `pi-sandbox/` cwd so `skills/pi-agent-builder`,
`.pi/extensions/…`, and `@prompt.md` paths resolve. Useful for
exploratory sessions where you want to edit the shared sandbox
directly.

For prompts with lots of nested quotes, put the prompt in a file under
`pi-sandbox/.pi/scratch/` and pass `@.pi/scratch/prompt.md` — cleaner
than escaping inline `-p "..."`.

### Where agent code lives

| Location (from `pi-sandbox/` cwd) | Behavior |
| --- | --- |
| `.pi/extensions/<name>.ts` | Project-local, auto-discovered by pi |
| `.pi/components/<name>.ts` | Curated reusable child-only parts; loaded via `pi -e <abs path>` from a parent extension. NOT auto-discovered by the parent pi session, so safe to register tools that shadow built-ins (e.g. a stub `stage_write` in place of the real `write`). |
| `~/.pi/agent/extensions/<name>.ts` | Global, hot-reloadable via `/reload` |
| `pi -e ./path.ts` | One-off test load (not hot-reloadable) |

### Mandatory safety rails for sub-agents

When an extension delegates to a child `pi` process:

- Pass `--no-extensions` to the child — prevents recursive sub-agents.
- Whitelist the child's tools (`--tools <verbs>`) to match its role.
  Drafter children typically get `stage_write,ls` (no `read`); recon
  children get `ls,grep,glob`. Omit every verb the role doesn't need —
  `read` on a writer leaks the "stub is the only write channel"
  guarantee, and default tool sets invite `bash` loops.
- Forward the parent's `AbortSignal` and truncate captured stdout (~20 KB).
- Match the tier to the child's role: `$TASK_MODEL` for workers,
  `$LEAD_MODEL` for reviewers, `$PLAN_MODEL` for orchestration.

See `pi-sandbox/skills/pi-agent-builder/references/` for recipe-level detail.

### Worked examples

Two live reference implementations, each illustrating a distinct
pattern. Docs under `pi-sandbox/skills/pi-agent-builder/references/`
cite them by path; do not edit them without updating the references.

- **Single-task drafter** — `pi-sandbox/.pi/extensions/deferred-writer.ts`
  paired with `pi-sandbox/.pi/components/stage-write.ts`. A
  `/deferred-writer <task>` slash command spawns one drafter child
  whose only write channel is a stub `stage_write` tool. Inputs are
  harvested from the parent's NDJSON event stream, buffered in parent
  memory, previewed via `ctx.ui.confirm`, and `fs.writeFileSync`'d
  into `pi-sandbox/` only on approval.
- **Orchestrator-over-extension** — `pi-sandbox/.pi/extensions/delegated-writer.ts`
  paired with `pi-sandbox/.pi/components/run-deferred-writer.ts` and
  `pi-sandbox/.pi/components/review.ts`. A `/delegated-writer <task>`
  slash command spawns one *persistent RPC* delegator LLM with two
  stub tools (`run_deferred_writer` dispatches a drafter; `review`
  approves or revises a draft). The parent harvests both stub calls
  from NDJSON, runs actual drafter children in parallel, feeds each
  produced file back to the delegator for review, and iterates up to
  3 revise rounds. No human confirm — the reviewer LLM is the gate.
  A live dashboard (`ctx.ui.setWidget` + `ctx.ui.setStatus`) tracks
  per-drafter phase + cost; a combined final notify reports promoted
  files + session cost breakdown.

Every always-on rail from
`pi-sandbox/skills/pi-agent-builder/references/defaults.md` is applied
in both.

## Scripted (non-interactive) pi invocations

Gotchas we've hit when calling `pi -p` from scripts:

- **Text mode buffers stdout.** The default `--mode text` emits nothing until
  the run completes, so progress (and hangs) are invisible. Use
  `--mode json` — it streams NDJSON events line by line (`turn_start`,
  `tool_execution_start`/`_end`, `message_update`, `agent_end`, etc.).
- **Idle tools invite exploration loops.** With the default tool set and a
  coding-agent system prompt, many models spontaneously run `bash`/`read`
  even for trivial prompts, burning turns and minutes. Always either
  `--no-tools` (pure completion) or `--tools <allowlist>` sized to the job.
- **`timeout` doesn't reach pi through `npm exec`.** SIGTERM kills the
  wrapper but the grandchild `pi` keeps running. If you need a hard ceiling,
  also kill the surviving `pi` PID explicitly.
- **Slash commands DO execute in `-p` mode.** `pi -p "/cmd args"` routes
  through `_tryExecuteExtensionCommand` before hitting the LLM. Useful
  diagnostic: in `--mode json`, a *registered* command emits only the
  `session` header on stdout (handler fires, no LLM call); an
  *unregistered* `/cmd` produces the full turn-start/message_update/turn_end
  event cascade. Count types to tell which happened without spending tokens.
- **`ctx.ui.notify` is a no-op in print mode** (`runner.js`'s
  `noOpUIContext`). Mid-run progress messages never reach the NDJSON
  stream — grade/monitor harnesses cannot use notify content as evidence
  of anything. Interactive mode is the only place they surface.
- **`ctx.ui.confirm` returns `false` unconditionally in print mode.** An
  approval-gated command called with `-p` will always hit the cancel
  path immediately. Extensions must exit cleanly on that branch (notify
  "cancelled" and return) or the handler errors out and leaks the wiped
  state. This makes `-p '/your-approval-command …'` a cheap behavioral
  smoke test for the cancel path, but useless for testing the approve
  path.
- **No `--model` + no `--provider` silently defaults to
  `openai/gpt-5.1-codex`.** Not openrouter, not any tier var from
  `models.env`. Always pass both flags explicitly in scripted runs; a
  missing `--model` is a silent cost regression into a different
  provider.

Recommended scripted pattern:

```sh
npm run pi -- --mode json --no-tools \
  --provider openrouter --model "$TASK_MODEL" \
  --no-session --no-skills --no-extensions \
  -p "$prompt" \
  | jq -c 'select(.type | IN("tool_execution_start","turn_end","agent_end"))'
```

### RPC mode — persistent single-spawn children

`--mode rpc` keeps one child pi alive across multiple prompts in the
same session (same conversation history, same LLM memory, same
accumulated cost). Protocol is line-delimited JSON on both channels:

- Parent → child on stdin: `{"type":"prompt","message":"…"}\n` per
  turn. More commands exist (`get_session_stats`, etc.); check
  `node_modules/@mariozechner/pi-coding-agent/dist/modes/rpc/…` if you
  need them.
- Child → parent on stdout: the same NDJSON event stream as `--mode
  json` (`turn_start`, `tool_execution_start`/`_end`, `message_update`,
  `message_end`, `agent_end`, …). `message_end` events carry
  `message.usage.cost.total: number` — accumulate across events for
  the session total.

Choose RPC over the one-shot `--mode json -p` pattern when:

- The child needs to see its own previous output across "phases"
  (dispatch → review → revise loop) without re-priming the context.
- You want a single cost meter for the whole session instead of
  summing across respawns.
- The tool surface differs per phase but the *conversation* is one
  continuous thread. RPC can't re-scope `--tools` mid-session, so
  pass the union of tools the session will ever need and narrow
  **by the prompt** that opens each phase.

Reference implementation: `pi-sandbox/.pi/extensions/delegated-writer.ts`
spawns one RPC delegator with `--tools run_deferred_writer,review` and
drives it through dispatch → review → revise phases via three
different prompts on the same stdin.

## Gotchas we've hit (pi API)

Four sharp edges we've paid for in this repo. Each one is enforced in
`pi-agent-builder`'s references but surfaces here so humans reading
`AGENTS.md` hit them before pi does:

- **`StringEnum` is a named export, not a method on `Type`.** `Type.StringEnum(...)`
  throws at runtime. Use `import { StringEnum } from "@mariozechner/pi-ai"`
  and call it directly: `verdict: StringEnum(["approve","revise"] as const, { description: "…" })`.
- **Tool `execute` return MUST include `details`.** Returning only
  `{ content: [...] }` fails TS compile — `AgentToolResult<unknown>`
  requires it. For stubs pass `details: {}`; for real tools echo the
  structured output you'd want a custom renderer to see.
- **`process.env.FOO` type narrowing doesn't survive closures.** After
  `const FOO = process.env.FOO; if (!FOO) return;` the *outer* binding
  is narrowed to `string`, but a nested function (a drafter helper, an
  event handler) loses the narrowing and sees `string | undefined`.
  Either reassign to a typed `const FOO_NARROWED: string = FOO;`, use
  a non-null assertion at the inner use site, or pass `FOO` as a
  parameter into the nested function.
- **Pi's TUI collapses consecutive info-level notifies.** `showStatus`
  (the info-level renderer at `dist/modes/interactive/interactive-mode.js:2375`)
  *replaces* the previous status line in place when two info-level
  `ctx.ui.notify` calls arrive back-to-back, so mid-run progress
  messages silently overwrite one another. Workarounds: combine into
  one multi-line notify, interleave a non-info notify (warning/error)
  between them, or use `ctx.ui.setWidget` for persistent multi-line
  state that should stay on screen.
- **`pi -e <path>` silently ignores default-exported non-function modules.**
  The loader expects `export default function (pi: ExtensionAPI) { … }`.
  A file that does `const tool: Tool = { … }; export default tool;`
  loads without error but registers nothing, so the child LLM has no
  way to call the stub, `tool_execution_start` for its name never
  fires, and a stub-write harness silently collects zero staged
  writes. Always wrap tool definitions in the factory shape, even
  for child-only stub files.

## Gotchas we've hit (harness / multi-run orchestration)

When running pi in a loop (skill evals, regression harness, batch
generation), a separate class of issues surfaces:

- **`npm run pi` re-sources `models.env` on every invocation.** Env-var
  overrides set by the outer caller get clobbered when the script
  re-runs `set -a; source models.env; set +a`. To iterate on a subset
  of `AGENT_BUILDER_TARGETS`, either edit `models.env` directly or
  set the override *after* the source step inside your wrapper.
- **Models write files anywhere they think "the project" lives** (historical). A
  single-model run that produced a "correct" extension could still
  land it in `/home/user/AgentFactory/.pi/extensions/` (repo root),
  `/home/user/.pi/agent/extensions/` (global), or
  `pi-sandbox/<stray>.md` (sandbox root) — none of which is the
  canonical `pi-sandbox/.pi/extensions/`. Resolved for the
  agent-maker path by `pi-sandbox/.pi/components/cwd-guard.ts`,
  a pi extension loaded via `-e` that registers `sandbox_write` /
  `sandbox_edit` tools with path validation against
  `$PI_SANDBOX_ROOT`, paired with a `--tools` allowlist that excludes
  the built-in `write` / `edit`. Each run gets its own cwd under
  `pi-sandbox/.pi/scratch/runs/<label>/` so escape attempts surface
  as tool errors, not silent writes to shared state. The legacy
  `npm run pi` path (direct skill invocation without agent-maker)
  still has the wide tool surface — use it only for interactive
  exploration, not batch runs.
- **Claude Code's `Monitor` tool can't be cancelled programmatically
  in this environment** — the Monitor description mentions `TaskStop`
  but it isn't surfaced as an available tool, so monitors run until
  their `timeout_ms` or their script exits. When the background job
  they're watching finishes via a separate completion notification,
  the monitor keeps running until its own timeout fires and then
  emits a stale `[Monitor timed out]` event. These trailing events
  are cosmetic — ignore them. Mitigations: arm the monitor with a
  `timeout_ms` close to the expected runtime rather than the max
  (keeps stale-event latency low), and don't start a new monitor
  on top of a stale one for an unrelated test.
- **Don't hand Claude Code a plan that says "copy a big file verbatim,
  then edit sections" and expect it to emit the result in a single
  `Write` call.** We hit this with `scripts/grade-deferred-writer.sh`
  (571 lines / 23 KB of escape-heavy bash — nested quote regexes,
  heredocs, `awk -F:` + `printf`-built JSON). Every attempt crashed
  at the same point: the small rubric committed fine, then the
  grader copy died mid-`Write`. The failure is some mix of
  per-response output-token ceiling, JSON-escape corruption of the
  tool-call argument under length, and plain attention divergence
  on "copy exactly 400 lines, change nothing." The fix is to keep
  the body off the model's output stream entirely: `cp <src> <dst>`
  via Bash, then one `Edit` per swap-map row with
  `old_string`/`new_string` scoped to <30 lines. `sed -i` is **not**
  a substitute — regex-heavy bash fights `sed`'s own quote escaping
  in a different but equally bad way. Treat "re-emit a >~300-line
  transformed copy via a single `Write`" as the anti-pattern and
  always decompose it into `cp` + targeted `Edit`s.
- **Recon behavioral probe runs `behavioral=partial` on `$TASK_MODEL`
  (deepseek-v3.2).** The grader looks for a `.md`/`.txt` file under
  `.pi/scratch/` containing the `evidence_anchor` string (e.g.
  `SKILL.md`). Generated recon extensions write that file only when
  their child pi (also on `$TASK_MODEL`) calls the `emit_summary` stub
  tool — and deepseek-v3.2 regularly skips the stub call on recon
  prompts, so the parent's handler returns via the silent
  `summaries.length === 0` branch (`ctx.ui.notify` is a no-op in
  print mode, so the failure doesn't surface in NDJSON). This affects
  the hand-authored `recon-agent` task equally — confirmed with an
  A/B re-run on haiku — so it is a model-capability ceiling, not a
  harness regression. Narrowing the agent-maker skill symlink
  (`agent-maker.sh` only mounts `skills/$SKILL_NAME`, not the whole
  tree) and the `seedReconFixture` helper in
  `scripts/approach-b-framework/grader/lib/probes.ts` both stay in
  place as correct test-isolation; neither flips the partial. If you
  need to close it later, options are: (a) use `$LEAD_MODEL` for the
  recon probe's child specifically, (b) log the child's stdout to a
  scratch file so the silent early-exit branches become visible, or
  (c) relax the evidence check. For now, treat recon `behavioral=
  partial` as an expected "mostly passing" ceiling.

## Repo layout

- `package.json` — ESM project, pins `@mariozechner/pi-coding-agent`. The
  `pi` script cds into `pi-sandbox/` and passes `--no-context-files`.
- `models.env` — tier → model-ID mapping (see above).
- `AGENTS.md` / `CLAUDE.md` — human docs about this repo. **Not** loaded
  into pi sessions (`npm run pi` passes `-nc`).
- `pi-sandbox/` — pi's cwd. Every pi invocation should run from here so
  auto-discovery stays scoped.
  - `pi-sandbox/.pi/extensions/` — project-local pi extensions
    (auto-discovered when cwd = `pi-sandbox/`, tracked in git).
  - `pi-sandbox/.pi/components/` — curated reusable child-only parts
    (cwd-guard, stage-write, review, run-deferred-writer) loaded into
    child pi processes via `pi -e <abs path>`, not auto-discovered by
    the parent. See `stage-write.ts` for the pattern. Distinct from
    pi's per-cwd `.pi/child-tools/` convention (which a generated
    extension writes to under its own cwd); this directory is the
    repo's *curated* library.
  - `pi-sandbox/.pi/scratch/` — throwaway prompt files, raw pi output,
    anything you don't want to check in. Gitignored.
  - `pi-sandbox/skills/pi-agent-builder/` — pi skill that teaches pi how
    to build agents.

Additional agent definitions, extensions, skills, or prompt templates can be
added under `pi-sandbox/` and loaded via `-e <path>` / `--skill <path>`.

## Workflow

- **Build pi extensions by having pi build them.** The preferred path is
  `npm run pi -- --skill skills/pi-agent-builder -p "<short description>"`
  (or via `@.pi/scratch/prompt.md` for longer asks). The `pi-agent-builder`
  skill is written for pi to consume, not for Claude or any other harness
  to read on its behalf.
- **Short natural-language prompts are the norm.** If a short prompt
  produces an incorrect or unsafe extension, the fix is to refine the
  skill — add the missing signal to
  `pi-sandbox/skills/pi-agent-builder/references/reading-short-prompts.md`
  or the missing rail to `.../references/defaults.md` — rather than
  padding every prompt with a full technical spec.
- **Scratch artifacts live in `pi-sandbox/.pi/scratch/`** (gitignored).
  Raw pi output, throwaway prompt files, and experiments go there and
  stay out of the tracked tree.

## Conventions

- Develop on the designated feature branch for the current task; do not
  push to other branches without explicit approval.
- Commit messages should explain the *why* concisely.
- Don't commit secrets — `.env`, `.env.local`, and `node_modules/` are already
  ignored.
