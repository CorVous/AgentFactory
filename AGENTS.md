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
- Every instance — root or delegated — gets a unique
  `<breed>-<shortName>` name (a hare breed for `LEAD_HARE_MODEL`,
  rabbit otherwise) generated at launch. The slug is the canonical
  `--agent-name`, the bus socket identity, and (prettified) the title
  in the header / delegation boxes. Override with `-- --agent-name
  <name>` when peers need a stable role name.

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

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
