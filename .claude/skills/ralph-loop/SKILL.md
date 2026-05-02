---
name: ralph-loop
description: Run the Ralph Wiggum loop — repeatedly plan, implement, review, and merge unblocked issues until the backlog is empty. Use when the user wants to clear an issue backlog autonomously, asks to "run the ralph loop", or wants to fan out parallel agents across unblocked issues.
---

# Ralph Loop

A round-based loop that drains an issue backlog by spawning specialised subagents per issue. Each agent works in its own isolated git worktree so parallel agents can't stomp on each other. The merge agent runs smoke tests per branch; the orchestrator runs one final integration smoke after the loop exits, then produces checklists for the human.

## Setup

Before the first round, read `AGENTS.md` (or `CLAUDE.md` as a fallback) at the repo root to discover:

- Where issues live (issue tracker / local markdown / etc.) and the commands to list, view, comment on, and close them
- How to run the typecheck, unit-test, and integration / smoke-test commands
- Branch naming and source-branch conventions

If `AGENTS.md` is missing, ask the user once for those commands and proceed. Pass these conventions into every subagent prompt — subagents do not re-discover them.

Pick a `{{WORKTREES_DIR}}` (default `.ralph-worktrees/` at the repo root, gitignored). Every subagent that touches code gets its own worktree underneath this dir, never the main checkout.

## The Loop

Each round runs four phases. Repeat until the planner returns zero unblocked issues, **or 10 rounds have completed** — whichever happens first. After the loop exits, run one integration smoke and produce the checklists.

### Phase 1 — Plan (one agent, no worktree)

Spawn **one Opus** subagent with [plan.md](plan.md). It runs read-only in the main checkout. It returns a JSON list of unblocked issues with assigned branch names, wrapped in `<plan>` tags. If the list is empty, the loop is done.

### Phase 2 — Implement (parallel, isolated worktrees)

For every issue in the plan, the orchestrator first creates a fresh worktree:

```
git worktree add {{WORKTREES_DIR}}/impl-{id} -b {branch} {source_branch}
```

Then spawn a **Sonnet** subagent with [implement.md](implement.md), passing the worktree path as `{{WORKTREE}}`. These run **in parallel**. Each agent is locked to its worktree and cannot see other agents' uncommitted work. Each implementer rebases its worktree on the source branch before doing anything else (enforced by the prompt), then does red→green TDD, commits, and comments on its issue.

Wait for all implementers. Do **not** delete the worktrees yet — review uses them.

### Phase 3 — Review (parallel, same worktrees)

For every branch from Phase 2, spawn a **Sonnet** subagent with [review.md](review.md) pointed at the same worktree the implementer used. Reviews run **in parallel**. Each reviewer verifies deliverables against the issue, runs typecheck and unit tests, refactors for clarity, and commits any improvements.

After all reviewers finish, the worktrees can be removed — the branches still exist:

```
git worktree remove {{WORKTREES_DIR}}/impl-{id}
```

### Phase 4 — Merge (one agent, isolated worktree)

Create a fresh worktree off the current source branch for the merger:

```
git worktree add {{WORKTREES_DIR}}/merge -b ralph-merge-round-{N} {source_branch}
```

Spawn **one Opus** subagent with [merge.md](merge.md), passing the worktree path, the list of branches, and their issue ids. It merges branches sequentially into its worktree, resolves conflicts, runs **typecheck + unit + smoke** tests after each merge, and leaves a tracking comment on each issue with the merge-commit SHA. **Issues are not closed at this stage** — they stay open until the human merges the PR.

When the merger finishes, fast-forward the source branch to the merger's tip, then remove the merger's worktree.

### End-of-round check

Increment the round counter. If `< 10` and the planner returned more than zero issues last time, restart from Phase 1 — the new plan call will see freshly closed issues and surface anything that just became unblocked. Otherwise exit the loop.

## Final integration smoke (after the loop)

Once the loop has exited, the orchestrator runs the project's full integration / smoke command on the merged source branch — one final pass to catch anything the per-branch smokes missed. If it fails, note the failure in the round summary and surface it at the top of the human QA checklist.

## Checklists (after the smoke)

After the integration smoke, the orchestrator produces two checklists. See [checklists.md](checklists.md) for the format. Every item must cite the issue id and the merge commit that owns it.

- **Human QA checklist** — things only a human can verify: visual / UX behaviour, real third-party integrations, multi-user flows, perceived performance, copy and tone. Do **not** include items that are already covered by automated tests, type checks, or simple `grep`-able invariants — those belong inside the loop.
- **Code review checklist (optional)** — points where a human reviewer's judgement adds value: architectural fit, naming choices, security review of auth-touching code, public API stability. Skip items a reviewer would just `grep` or run tests for.

The orchestrator's job ends here. The human now reviews the checklists, opens a PR for the round branch, works through QA, and merges the PR.

## After the human merges the PR (separate invocation)

Once the human has signed off on QA and merged the round's PR into the long-lived branch, they run a final close-out step. This is **not part of the main loop** — it's a separate agent invocation triggered by the human after the PR lands.

Spawn **one Sonnet** subagent with [close.md](close.md), passing the issue → merge-commit mapping the merge agent reported. It verifies each commit is reachable from the long-lived branch, then closes the corresponding issue with a comment that cites the commit (and optional PR number) that solved it.

Issues only get closed in this final step. Anything that was skipped during merge, or whose commit didn't make it onto the long-lived branch, stays open.

## Termination

The loop exits when any of these happens:

- The planner returns zero unblocked issues
- 10 rounds have completed
- The merge agent reports an unresolvable conflict and the user has not given guidance
- The user interrupts

In every exit case, still run the final integration smoke and produce the checklists for whatever did land.

## Subagent prompts

Fill in the bracketed placeholders before spawning each subagent:

- [plan.md](plan.md) — `{{ISSUE_TRACKER_COMMANDS}}`
- [implement.md](implement.md) — `{{TASK_ID}}`, `{{ISSUE_TITLE}}`, `{{BRANCH}}`, `{{SOURCE_BRANCH}}`, `{{WORKTREE}}`, `{{ISSUE_TRACKER_COMMANDS}}`, `{{TEST_COMMANDS}}`
- [review.md](review.md) — `{{BRANCH}}`, `{{SOURCE_BRANCH}}`, `{{WORKTREE}}`, `{{TEST_COMMANDS}}`
- [merge.md](merge.md) — `{{BRANCHES}}`, `{{ISSUES}}`, `{{WORKTREE}}`, `{{ISSUE_TRACKER_COMMANDS}}`, `{{TEST_COMMANDS}}`
- [close.md](close.md) — `{{ISSUES}}`, `{{PR_NUMBER}}` (optional), `{{ISSUE_TRACKER_COMMANDS}}` — run **after** the human merges the PR

## Round summary

After each round, report concisely: round number, how many issues were planned, how many merged successfully, how many were skipped and why, and how many remain open. After the loop exits, append the integration smoke result and the two checklists.
