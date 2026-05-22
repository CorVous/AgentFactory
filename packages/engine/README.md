# @agentfactory/pi-engine

The AgentFactory engine pi package. Provides `pi --recipe <name>` to launch a
focused agent with model, tool allowlist, and system prompt applied from a YAML
recipe.

## Install

```sh
pi install npm:@agentfactory/pi-engine
```

After installing, the `recipe-loader` extension auto-loads on every `pi`
invocation. When no `--recipe` flag is passed, the extension is **inert** —
plain `pi` behaves identically to vanilla pi (loaded-but-inert guarantee per
ADR-0010).

## Usage

```sh
pi --recipe <name>          # launch a focused agent from a bundled recipe
pi --recipe <name> -p "…"  # non-interactive / print mode
```

Recipe files are resolved in order:

1. `<cwd>/.pi/recipes/<name>.yaml` — project-local
2. Bundled in this package at `agent/recipes/<name>.yaml`

## Recipe format

```yaml
model: TASK_RABBIT_MODEL          # tier var (from models.env) or literal model ID
tools: [read, ls, grep]           # tool allowlist
prompt: |                         # system prompt for the agent
  You are a careful reader...
description: Reads files…         # optional; shown in the TUI header
extensions: [deferred-write]      # optional; rails to load
skills: [pi-agent-builder]        # optional; skills to activate
spawns: [child-recipe]            # optional; recipes this agent may spawn via mesh_spawn
```

Source `models.env` before launching so tier vars resolve:

```sh
set -a; source models.env; set +a
pi --recipe my-agent
```

## Tier vars

| Variable | Role |
|---|---|
| `TASK_RABBIT_MODEL` | Worker — bulk task execution, cost-optimised |
| `LEAD_HARE_MODEL` | Overseer — reviews output, assigns follow-ups |
| `RABBIT_SAGE_MODEL` | Planner — whole-picture strategy, frontier reasoning |

## Development / contributing

Tests: `npm test` (vitest, hermetic — no model calls, no network).
