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

Agent definitions, extensions, and skills can be added under directories like
`agents/`, `extensions/`, or `skills/` and loaded via `-e <path>` /
`--skill <path>` when launching pi.

## Conventions

- Develop on the designated feature branch
  (`claude/setup-pi-agent-project-fegzL` for the current setup task); do not
  push to other branches without explicit approval.
- Commit messages should explain the *why* concisely.
- Don't commit secrets — `.env`, `.env.local`, and `node_modules/` are already
  ignored.
