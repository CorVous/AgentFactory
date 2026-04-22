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

## Repo layout

- `package.json` — ESM project, pins `@mariozechner/pi-coding-agent`.
- `models.env` — tier → model-ID mapping (see above).
- `CLAUDE.md` — this file.
- `skills/pi-agent-builder/` — bundled pi skill that teaches the agent how to
  build pi extensions and sub-agents. Not auto-discovered (see below).

Agent definitions, extensions, and skills can be added under directories like
`agents/`, `extensions/`, or `skills/` and loaded via `-e <path>` /
`--skill <path>` when launching pi.

## Building agents with the `pi-agent-builder` skill

The skill at `skills/pi-agent-builder/` is the playbook for creating pi
extensions and sub-agents. It covers tools, slash commands, lifecycle events,
sub-agent delegation, packaging, and evals — read `skills/pi-agent-builder/SKILL.md`
for the index. The pi-side reference docs live at
`node_modules/@mariozechner/pi-coding-agent/docs/` (treat them as ground truth
when the skill and the installed API disagree).

### Loading the skill

Pi auto-discovers skills from `~/.pi/agent/skills/`, `.pi/skills/`,
`.agents/skills/`, and package `skills/` directories. The bundled location
(`skills/pi-agent-builder/`) is **not** one of those paths, so the skill must
be loaded explicitly. Pick one:

- **One-off:** `npx pi --skill skills/pi-agent-builder ...`
- **Project default:** create `.pi/settings.json` with
  `{"skills": ["skills/pi-agent-builder"]}` so every `pi` invocation in this
  repo picks it up.
- **Force-load mid-session:** type `/skill:pi-agent-builder` in the TUI to pull
  the full SKILL.md into context (descriptions are always in the system prompt;
  the body loads on demand).

### Workflow for creating a new pi agent

1. **Source the model tiers and start pi with the skill:**

   ```sh
   set -a; source models.env; set +a
   npx pi --provider openrouter --model "$PLAN_MODEL" \
          --skill skills/pi-agent-builder
   ```

   Use `$PLAN_MODEL` for design work; downgrade to `$LEAD_MODEL` /
   `$TASK_MODEL` once the plan is concrete.

2. **Tell pi what you want.** Pi reads the skill's frontmatter from the system
   prompt and decides whether to load the body. To force it, run
   `/skill:pi-agent-builder` first, then describe the agent (trigger, tools,
   failure modes, model tier).

3. **Pick the right primitive.** The skill's decision tree (SKILL.md) maps the
   ask to a recipe under `skills/pi-agent-builder/references/`:
   - LLM-callable tool → `tool-recipe.md`
   - User slash command → `command-recipe.md`
   - Lifecycle interception → `events-recipe.md`
   - **Sub-agent (a child pi session as a tool)** → `subagent-recipe.md`
   - Custom context/memory → `context-and-memory.md`

4. **Place the generated extension where pi will find it.** For project-local
   work, drop the TypeScript file in `.pi/extensions/<name>.ts` (auto-discovered
   and hot-reloadable via `/reload`). For throwaway tests, run
   `npx pi -e ./path/to/extension.ts`.

5. **Wire the model tier into the sub-agent.** Sub-agents shell out to `pi`
   as a child process; pass the right tier and `--no-extensions` to prevent
   recursive spawning:

   ```ts
   spawn("pi", [
     "-p", task,
     "--no-extensions",
     "--provider", "openrouter",
     "--model", process.env.TASK_MODEL!,  // or LEAD_MODEL / PLAN_MODEL
   ], { signal });
   ```

6. **Verify.** `/reload` after edits, exercise the tool, and confirm graceful
   failure (network down, bad input, user cancel). Add evals only when the
   contract is deterministic — see `references/evals.md`.

### Provider note

Model IDs in `models.env` (e.g. `deepseek/deepseek-v3.2`) are OpenRouter-style,
so launches need `OPENROUTER_API_KEY` in `.env` and `--provider openrouter`
(or set `pi`'s default provider in `.pi/settings.json`). Without the key, pi
errors out at the first model call.

## Conventions

- Develop on the designated feature branch for the current task; do not push
  to other branches without explicit approval.
- Commit messages should explain the *why* concisely.
- Don't commit secrets — `.env`, `.env.local`, and `node_modules/` are already
  ignored.
