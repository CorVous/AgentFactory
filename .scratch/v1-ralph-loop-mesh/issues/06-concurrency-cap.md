Status: ready-for-agent

# Concurrency cap (`--max-concurrent-foremen`)

## Parent

[PRD-0001: Ralph-Loop mesh for AgentFactory V1](../PRD.md)

## What to build

Wire the Kanban's hardcoded max-concurrent-Foremen value (placeholder from #03) to a configurable launcher flag, so a flood of ready issues cannot melt the user's machine or budget (story #6).

- Launcher accepts `--max-concurrent-foremen <N>` and forwards it to the Kanban as a CLI flag.
- Kanban's spawn-decision pure function already takes `maxConcurrent` as a parameter (per #03's shape). This issue adds the flag plumbing and a sensible default (e.g., `2` or `4` — author's call, document in the launcher help).
- The pure function's existing unit tests cover the cap behaviour; this issue adds tests for the flag-default and flag-override paths through the launcher.

## Acceptance criteria

- [ ] Launcher accepts `--max-concurrent-foremen <N>`; missing flag uses a documented default.
- [ ] Kanban receives the value via the existing CLI-flag plumbing from `scripts/run-agent.mjs` (or the Kanban-specific launcher equivalent).
- [ ] Spawn-decision pure-function unit tests cover: `N=1` allows one Foreman in flight, `N=3` allows three, ready-but-over-cap issues are deferred to the next wake.
- [ ] Manual verification: a fixture project with N+1 ready issues sees exactly N Foremen alive concurrently; the (N+1)th dispatches when one of the first N exits.

## Blocked by

- #03 — AFK trunk end-to-end (Kanban + spawn-decision land there)

## Comments
