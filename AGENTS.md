# AgentFactory

Workspace for building and testing **pi agents** using
[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-mono). Pi is
installed as a regular npm dependency so the `pi` CLI is available via
`node_modules/.bin/pi`.

```sh
npm install
set -a; source models.env; set +a
pi --recipe deferred-writer                 # focused agent, sandboxed to $PWD
npm run pi                                  # raw pi session for exploration
```

## How agents work in this repo

- `pi --recipe <name>` reads a YAML recipe from `pi-sandbox/agents/`
  (project-local `.pi/recipes/` is also searched first), loads rails
  from the installed engine and cluster packages, and configures the
  pi session with the recipe's prompt, tools, extensions, and skills.
  Full reference: [`docs/agents.md`](./docs/agents.md).
- Models live in `models.env` and are addressed by tier:
  `RABBIT_SAGE_MODEL` (planner), `LEAD_HARE_MODEL` (overseer),
  `TASK_RABBIT_MODEL` (worker). Full reference:
  [`docs/model-tiers.md`](./docs/model-tiers.md).
- Every instance gets a unique `<breed>-<shortName>` name generated at
  launch. The slug is the canonical `--peer-name`, the bus socket
  identity, and (prettified) the title in the header. Override with
  `--peer-name <name>` when peers need a stable role name.

## More docs

- [`docs/agents.md`](./docs/agents.md) — `pi --recipe` recipe shape,
  prompt fragments, per-instance names, and a map into the focused
  `docs/agents/` references (rails, worked examples, multi-agent,
  topology, testing).
- [`docs/model-tiers.md`](./docs/model-tiers.md) — tier → model-ID table.
- [`docs/pi-direct.md`](./docs/pi-direct.md) — running raw pi, the
  `pi-agent-builder` skill, scripted (`-p`) gotchas.
- [`docs/repo-layout.md`](./docs/repo-layout.md) — directory tour and the
  build-by-pi workflow.
- [`docs/conventions.md`](./docs/conventions.md) — branch, commit, secrets.
- [`scripts/_lib/launcher-envelope.mjs`](./scripts/_lib/launcher-envelope.mjs) — typed wire format (`v: 1`) for the launcher control socket; reference for extension authors emitting focus-request, pin-request, tail-event, and related envelopes.

## Agent skills

### Issue tracker

Issues live in GitHub Issues; skills use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and one `docs/adr/` at the repo root. See `docs/agents/domain.md`.

@docs/agents.md
@docs/model-tiers.md
