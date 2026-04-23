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

Source the file before launching pi so the tier vars are in scope:

```sh
set -a; source models.env; set +a
npm run pi -- --model "$TASK_MODEL"    # or $LEAD_MODEL / $PLAN_MODEL
```

`models.env` is committed because the IDs are not secrets. Put API keys in a
gitignored `.env` instead.

## Creating pi agents

Pi ships no sub-agent feature by default. Use pi itself with the bundled
`pi-agent-builder` skill — pi reads the skill on demand and generates
extensions that follow its recipes.

### Invoking the skill

```sh
set -a; source models.env; set +a
npm run pi -- --provider openrouter --model "$LEAD_MODEL" \
  --skill skills/pi-agent-builder \
  -p "Use the pi-agent-builder skill to <describe the agent>."
```

Paths (`skills/pi-agent-builder`, `.pi/extensions/…`, `@prompt.md`) resolve
from `pi-sandbox/` cwd, since `npm run pi` cds in.

For prompts with lots of nested quotes, put the prompt in a file under
`.pi/scratch/` and pass `@.pi/scratch/prompt.md` — cleaner than escaping
inline `-p "..."`.

### Where agent code lives

| Location (from `pi-sandbox/` cwd) | Behavior |
| --- | --- |
| `.pi/extensions/<name>.ts` | Project-local, auto-discovered by pi |
| `.pi/child-tools/<name>.ts` | Child-only; loaded via `pi -e <abs path>` from a parent extension. NOT auto-discovered by the parent pi session, so safe to register tools that shadow built-ins (e.g. a stub `stage_write` in place of the real `write`). |
| `~/.pi/agent/extensions/<name>.ts` | Global, hot-reloadable via `/reload` |
| `pi -e ./path.ts` | One-off test load (not hot-reloadable) |

### Mandatory safety rails for sub-agents

When an extension delegates to a child `pi` process:

- Pass `--no-extensions` to the child — prevents recursive sub-agents.
- Whitelist the child's tools (`--tools read,grep,...`) to match its role.
- Forward the parent's `AbortSignal` and truncate captured stdout (~20 KB).
- Match the tier to the child's role: `$TASK_MODEL` for workers,
  `$LEAD_MODEL` for reviewers, `$PLAN_MODEL` for orchestration.

See `pi-sandbox/skills/pi-agent-builder/references/` for recipe-level detail.

### Worked examples

Two live reference implementations, each illustrating a distinct
pattern. Docs under `pi-sandbox/skills/pi-agent-builder/references/`
cite them by path; do not edit them without updating the references.

- **Single-task drafter** — `pi-sandbox/.pi/extensions/deferred-writer.ts`
  paired with `pi-sandbox/.pi/child-tools/stage-write.ts`. A
  `/deferred-writer <task>` slash command spawns one drafter child
  whose only write channel is a stub `stage_write` tool. Inputs are
  harvested from the parent's NDJSON event stream, buffered in parent
  memory, previewed via `ctx.ui.confirm`, and `fs.writeFileSync`'d
  into `pi-sandbox/` only on approval.
- **Orchestrator-over-extension** — `pi-sandbox/.pi/extensions/delegated-writer.ts`
  paired with `pi-sandbox/.pi/child-tools/run-deferred-writer.ts` and
  `pi-sandbox/.pi/child-tools/review.ts`. A `/delegated-writer <task>`
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
  - `pi-sandbox/.pi/child-tools/` — tools meant to be loaded into
    child pi processes via `pi -e <abs path>`, not auto-discovered by
    the parent. See `stage-write.ts` for the pattern.
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
