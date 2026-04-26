# Composing agents — `npm run agent`

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

## Recipe shape

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

## Where agent code lives

| Location | Behavior |
| --- | --- |
| `pi-sandbox/agents/<name>.yaml` | Agent recipe consumed by `npm run agent` |
| `pi-sandbox/.pi/extensions/<name>.ts` | Project-local extension, auto-discovered by `npm run pi`; loaded explicitly by `npm run agent` when listed in a recipe |
| `~/.pi/agent/extensions/<name>.ts` | Global extension, hot-reloadable via `/reload` |
| `pi -e ./path.ts` | One-off test load (not hot-reloadable) |

## Worked example: deferred-writer

`pi-sandbox/agents/deferred-writer.yaml` composes three extensions:

- `sandbox` (baseline) — disables `bash`, clamps fs activity to the root.
- `deferred-write` — registers the `deferred_write` tool. Drafts are
  buffered in extension memory; on `agent_end` the extension previews the
  queued drafts via `ctx.ui.confirm` and writes approved ones to disk
  (sha256-verified after write, ≤ 50 files / ≤ 2 MB each).
- `no-edit` — blocks `edit` outright and rejects `write` /
  `deferred_write` whose target already exists. Drop this from the recipe
  if you want an agent that can overwrite or edit existing files.

Non-interactive runs refuse to write because there's no UI to confirm.

`deferred-write` and `no-edit` are independent rails: an agent that wants
overwrite-on-approval keeps `deferred-write` and omits `no-edit`; an
agent using plain `write` but still wanting create-only semantics keeps
`no-edit` and omits `deferred-write`.

## Mandatory safety rails for sub-agents

When an extension delegates to a child `pi` process:

- Pass `--no-extensions` to the child — prevents recursive sub-agents.
- Whitelist the child's tools (`--tools read,grep,...`) to match its role.
- Forward the parent's `AbortSignal` and truncate captured stdout (~20 KB).
- Match the tier to the child's role: `$TASK_RABBIT_MODEL` for workers,
  `$LEAD_HARE_MODEL` for reviewers, `$RABBIT_SAGE_MODEL` for orchestration.

See `pi-sandbox/skills/pi-agent-builder/references/` for recipe-level detail.
