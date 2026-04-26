# AgentFactory

Workspace for building and testing **pi agents** using
[`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono). Pi is
installed as a regular npm dependency so the `pi` CLI is available via
`node_modules/.bin/pi`.

```sh
npm install
set -a; source models.env; set +a
npm run agent -- deferred-writer            # focused agent, sandboxed to $PWD
npm run pi                                  # raw pi session for exploration
```

## How agents work in this repo

- `npm run agent -- <name>` reads a YAML recipe from `pi-sandbox/agents/`,
  applies the `sandbox` baseline (no `bash`, no fs activity outside the
  working directory), and execs pi with the recipe's prompt, tools,
  extensions, and skills. Full reference: [`docs/agents.md`](./docs/agents.md).
- Models live in `models.env` and are addressed by tier:
  `RABBIT_SAGE_MODEL` (planner), `LEAD_HARE_MODEL` (overseer),
  `TASK_RABBIT_MODEL` (worker). Full reference:
  [`docs/model-tiers.md`](./docs/model-tiers.md).

## More docs

- [`docs/agents.md`](./docs/agents.md) — `npm run agent` recipe shape,
  sandbox baseline, deferred-writer worked example, sub-agent rails.
- [`docs/model-tiers.md`](./docs/model-tiers.md) — tier → model-ID table.
- [`docs/pi-direct.md`](./docs/pi-direct.md) — running raw pi, the
  `pi-agent-builder` skill, scripted (`-p`) gotchas.
- [`docs/repo-layout.md`](./docs/repo-layout.md) — directory tour and the
  build-by-pi workflow.
- [`docs/conventions.md`](./docs/conventions.md) — branch, commit, secrets.

@docs/agents.md
@docs/model-tiers.md
