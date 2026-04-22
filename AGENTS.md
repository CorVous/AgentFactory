# AgentFactory

Workspace for building and testing **pi agents** using
[`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono). Pi is
installed as a regular npm dependency so the `pi` CLI is available via
`node_modules/.bin/pi`.

## Launching pi

- `npx pi` — interactive session
- `npm run pi` — same, via the script in `package.json`
- `npx pi --help` — full flag reference (`-e` for extensions, `--skill` for
  skills, `-p` for non-interactive mode, `--model` / `--provider` to target a
  specific model, etc.)

Dependencies live in `node_modules/` (gitignored); run `npm install` after
cloning.

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
npx pi --model "$TASK_MODEL"    # or $LEAD_MODEL / $PLAN_MODEL
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
npx pi --provider openrouter --model "$LEAD_MODEL" \
  --skill skills/pi-agent-builder \
  -p "Use the pi-agent-builder skill to <describe the agent>."
```

For prompts with lots of nested quotes, put the prompt in a file and pass
`@path/to/prompt.md` — cleaner than escaping inline `-p "..."`.

### Where agent code lives

| Location | Behavior |
| --- | --- |
| `.pi/extensions/<name>.ts` | Project-local, auto-discovered by pi |
| `~/.pi/agent/extensions/<name>.ts` | Global, hot-reloadable via `/reload` |
| `pi -e ./path.ts` | One-off test load (not hot-reloadable) |

### Mandatory safety rails for sub-agents

When an extension delegates to a child `pi` process:

- Pass `--no-extensions` to the child — prevents recursive sub-agents.
- Whitelist the child's tools (`--tools read,grep,...`) to match its role.
- Forward the parent's `AbortSignal` and truncate captured stdout (~20 KB).
- Match the tier to the child's role: `$TASK_MODEL` for workers,
  `$LEAD_MODEL` for reviewers, `$PLAN_MODEL` for orchestration.

See `skills/pi-agent-builder/references/` for recipe-level detail.

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
npx pi --mode json --no-tools \
  --provider openrouter --model "$TASK_MODEL" \
  --no-session --no-skills --no-extensions \
  -p "$prompt" \
  | jq -c 'select(.type | IN("tool_execution_start","turn_end","agent_end"))'
```

## Repo layout

- `package.json` — ESM project, pins `@mariozechner/pi-coding-agent`.
- `models.env` — tier → model-ID mapping (see above).
- `AGENTS.md` — this file (auto-loaded by pi at startup).
- `.pi/extensions/` — project-local pi extensions (auto-discovered by pi,
  tracked in git).
- `.pi/scratch/` — throwaway prompt files, raw pi output, anything you don't
  want to check in. Gitignored. Put temporary artifacts here (e.g. the
  `@path/to/prompt.md` files you feed to pi) so they don't clutter the
  working tree or leak into commits.
- `skills/pi-agent-builder/` — pi skill that teaches pi how to build agents.

Additional agent definitions, extensions, skills, or prompt templates can be
added and loaded via `-e <path>` / `--skill <path>` when launching pi.

## Workflow

- **Build pi extensions by having pi build them.** The preferred path is
  `npx pi --skill skills/pi-agent-builder -p "<short description>"` (or
  via `@path/to/prompt.md` for longer asks). The `pi-agent-builder` skill
  is written for pi to consume, not for Claude or any other harness to
  read on its behalf.
- **Short natural-language prompts are the norm.** If a short prompt
  produces an incorrect or unsafe extension, the fix is to refine the
  skill — add the missing signal to
  `skills/pi-agent-builder/references/reading-short-prompts.md` or the
  missing rail to `.../references/defaults.md` — rather than padding
  every prompt with a full technical spec.
- **Scratch artifacts live in `.pi/scratch/`** (gitignored). Raw pi
  output, throwaway prompt files, and experiments go there and stay out
  of the tracked tree.

## Conventions

- Develop on the designated feature branch
  (`claude/setup-pi-agent-project-fegzL` for the current setup task); do not
  push to other branches without explicit approval.
- Commit messages should explain the *why* concisely.
- Don't commit secrets — `.env`, `.env.local`, and `node_modules/` are already
  ignored.
