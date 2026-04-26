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
| `RABBIT_SAGE_MODEL` | Rabbit Sage — Planner / Orchestrator | Whole-picture strategy and subtask decomposition. Runs rarely; needs frontier reasoning and long-context coherence. |
| `LEAD_HARE_MODEL` | Lead Hare — Task Overseer | Reviews worker output, assigns follow-ups, keeps the plan on track. Runs often; solid reasoning but not frontier. |
| `TASK_RABBIT_MODEL` | Task Rabbit — Worker | Bulk task execution. Runs constantly; optimize for cost-per-token at acceptable quality. |

Source the file before launching pi so the tier vars are in scope:

```sh
set -a; source models.env; set +a
npm run pi -- --model "$TASK_RABBIT_MODEL"    # or $LEAD_HARE_MODEL / $RABBIT_SAGE_MODEL
```

`models.env` is committed because the IDs are not secrets. Put API keys in a
gitignored `.env` instead.

## Composing agents — `npm run agent`

Day-to-day, the way to launch a focused agent is `npm run agent -- <name>`.
The runner (`scripts/run-agent.mjs`) reads a YAML recipe from
`pi-sandbox/agents/<name>.yaml`, resolves the model tier, and execs `pi`
from the directory you invoked it from (or `--sandbox <dir>`). Every
agent gets the `sandbox` baseline extension, which blocks `bash` outright
and rejects any path-bearing tool call (`read`, `write`, `edit`, `ls`,
`grep`, `find`) whose `path` resolves outside the sandbox root.

```sh
set -a; source models.env; set +a
npm run agent -- deferred-writer            # interactive, sandboxed to $PWD
npm run agent -- deferred-writer --sandbox /tmp/scratch
npm run agent -- deferred-writer -p "draft a README" --thinking off   # passthrough
```

### Recipe shape

```yaml
# pi-sandbox/agents/<name>.yaml
model: TASK_RABBIT_MODEL          # tier name from models.env, or a literal model ID
prompt: |                         # replaces pi's default system prompt
  You are a careful drafter...
tools: [read, ls, grep, deferred_write]
extensions: [deferred-write]      # merged with the [sandbox] baseline
skills: [pi-agent-builder]        # optional; resolved against pi-sandbox/skills/
provider: openrouter              # optional; defaults to openrouter
```

The runner always passes `--no-extensions --no-skills --no-context-files`
to pi, so only what the recipe declares is loaded. Tool names go through
pi's `--tools` allowlist (built-in + extension-registered tools both
qualify). The sandbox extension reads `AGENT_SANDBOX_ROOT` (set by the
runner) to know where to clamp paths.

### Worked example: deferred-writer

`pi-sandbox/agents/deferred-writer.yaml` pairs the `deferred-write`
extension (`pi-sandbox/.pi/extensions/deferred-write.ts`) with the
sandbox baseline. The agent's only write channel is the `deferred_write`
tool, which buffers drafts in extension memory; on `agent_end` the
extension previews the queued drafts via `ctx.ui.confirm` and writes
approved ones to disk under the sandbox root (sha256-verified after
write, ≤ 50 files / ≤ 2 MB each). Non-interactive runs refuse to write
because there's no UI to confirm.

## Creating pi agents (the long way)

When the recipe-based runner isn't enough — e.g. you're building a brand
new extension or a multi-process pipeline — fall back to invoking pi
directly with the bundled `pi-agent-builder` skill. Pi reads the skill
on demand and generates extensions that follow its recipes.

### Invoking the skill

```sh
set -a; source models.env; set +a
npm run pi -- --provider openrouter --model "$LEAD_HARE_MODEL" \
  --skill skills/pi-agent-builder \
  -p "Use the pi-agent-builder skill to <describe the agent>."
```

Paths (`skills/pi-agent-builder`, `.pi/extensions/…`, `@prompt.md`) resolve
from `pi-sandbox/` cwd, since `npm run pi` cds in.

For prompts with lots of nested quotes, put the prompt in a file under
`.pi/scratch/` and pass `@.pi/scratch/prompt.md` — cleaner than escaping
inline `-p "..."`.

### Where agent code lives

| Location | Behavior |
| --- | --- |
| `pi-sandbox/agents/<name>.yaml` | Agent recipe consumed by `npm run agent` |
| `pi-sandbox/.pi/extensions/<name>.ts` | Project-local extension, auto-discovered by `npm run pi`; loaded explicitly by `npm run agent` when listed in a recipe |
| `~/.pi/agent/extensions/<name>.ts` | Global extension, hot-reloadable via `/reload` |
| `pi -e ./path.ts` | One-off test load (not hot-reloadable) |

### Mandatory safety rails for sub-agents

When an extension delegates to a child `pi` process:

- Pass `--no-extensions` to the child — prevents recursive sub-agents.
- Whitelist the child's tools (`--tools read,grep,...`) to match its role.
- Forward the parent's `AbortSignal` and truncate captured stdout (~20 KB).
- Match the tier to the child's role: `$TASK_RABBIT_MODEL` for workers,
  `$LEAD_HARE_MODEL` for reviewers, `$RABBIT_SAGE_MODEL` for orchestration.

See `pi-sandbox/skills/pi-agent-builder/references/` for recipe-level detail.

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
  --provider openrouter --model "$TASK_RABBIT_MODEL" \
  --no-session --no-skills --no-extensions \
  -p "$prompt" \
  | jq -c 'select(.type | IN("tool_execution_start","turn_end","agent_end"))'
```

## Repo layout

- `package.json` — ESM project, pins `@mariozechner/pi-coding-agent`.
  Defines `npm run pi` (raw pi from `pi-sandbox/`) and `npm run agent`
  (recipe-driven runner).
- `models.env` — tier → model-ID mapping (see above).
- `scripts/run-agent.mjs` — recipe runner used by `npm run agent`.
- `AGENTS.md` / `CLAUDE.md` — human docs about this repo. **Not** loaded
  into pi sessions (`npm run pi` and `npm run agent` both pass `-nc`).
- `pi-sandbox/` — pi's content lives here.
  - `pi-sandbox/agents/` — YAML recipes consumed by `npm run agent`.
  - `pi-sandbox/.pi/extensions/` — project-local pi extensions. Includes
    the `sandbox` baseline applied to every agent.
  - `pi-sandbox/.pi/scratch/` — throwaway prompt files, raw pi output,
    anything you don't want to check in. Gitignored.
  - `pi-sandbox/skills/pi-agent-builder/` — pi skill that teaches pi how
    to build agents.

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
