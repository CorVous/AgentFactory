# Composing agents — `npm run agent`

Day-to-day, the way to launch a focused agent is `npm run agent -- <name>`.
The runner (`scripts/run-agent.mjs`) reads a YAML recipe from
`pi-sandbox/agents/<name>.yaml`, resolves the model tier, and execs `pi`
from the directory you invoked it from (or `--sandbox <dir>`). Every
agent gets four baseline extensions:

- `sandbox` — blocks `bash` outright and rejects any path-bearing tool
  call whose `path` resolves outside the sandbox root. The set of
  path-bearing tools is discovered at session start from
  `pi.getAllTools()` (any tool whose schema declares `path: string`),
  with a static fallback of `{read, write, edit, ls, grep, find}` for
  the installed pi 0.69 built-ins.
- `no-startup-help` — suppresses pi's default startup header (logo,
  keybinding cheatsheet, onboarding tips) since most of those keybindings
  reference features focused agents don't use.
- `agent-footer` — replaces pi's default footer. Line 1 shows
  `sandbox: <root>` on the left and `tools: <name1, name2, ...>` (from
  `pi.getActiveTools()`, i.e. the recipe's `tools:` allowlist plus any
  extension-registered tools) on the right. Line 2 mirrors pi's default
  stats/model line. Line 3 is the extension-status line.
- `hide-extensions-list` — strips pi's `[Extensions]` section (added by
  `showLoadedResources` to the chat history at startup) since the
  agent-footer already shows the active tools and the path listing is
  noise. Reaches into private TUI state via `setWidget`+`setTimeout(0)`
  because pi has no public API to suppress per-section.

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
extensions: [deferred-write]      # merged with the [sandbox, no-startup-help, agent-footer, hide-extensions-list] baseline
skills: [pi-agent-builder]        # optional; resolved against pi-sandbox/skills/
provider: openrouter              # optional; defaults to openrouter
noEditAdd: [my_writer]            # optional; force-include in no-edit rail
noEditSkip: [deferred_write]      # optional; exempt from no-edit rail
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
- `no-edit` — blocks `edit` outright and rejects any create-only tool
  whose target already exists. The create-only set is discovered at
  session start from `pi.getAllTools()`: any tool whose schema declares
  `path: string` plus a content-shaped string field
  (`content` | `text` | `body`). The static fallback covers `write` and
  `deferred_write`. Override per recipe with `noEditAdd` (force-include)
  or `noEditSkip` (force-exclude). Drop the extension entirely if you
  want an agent that can overwrite or edit existing files.

Non-interactive runs refuse to write because there's no UI to confirm.

`deferred-write` and `no-edit` are independent rails: an agent that wants
overwrite-on-approval keeps `deferred-write` and omits `no-edit`; an
agent using plain `write` but still wanting create-only semantics keeps
`no-edit` and omits `deferred-write`.

### Debugging the rails

Set `AGENT_DEBUG=1` in the environment when launching an agent and the
`sandbox` and `no-edit` extensions will dump their resolved tool sets
via `ctx.ui.notify` on `session_start`. Useful when you've added a new
write tool and want to confirm it was picked up by introspection.

```sh
AGENT_DEBUG=1 npm run agent -- deferred-writer -p "ping"
```

## Mandatory safety rails for sub-agents

When an extension delegates to a child `pi` process:

- Pass `--no-extensions` to the child — prevents recursive sub-agents.
- Whitelist the child's tools (`--tools read,grep,...`) to match its role.
- Forward the parent's `AbortSignal` and truncate captured stdout (~20 KB).
- Match the tier to the child's role: `$TASK_RABBIT_MODEL` for workers,
  `$LEAD_HARE_MODEL` for reviewers, `$RABBIT_SAGE_MODEL` for orchestration.

See `pi-sandbox/skills/pi-agent-builder/references/` for recipe-level detail.
