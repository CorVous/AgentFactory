---
name: ralph-loop
description: Run the Ralph Wiggum loop — repeatedly plan, implement, review, and merge unblocked issues until the backlog is empty. Use when the user wants to clear an issue backlog autonomously, asks to "run the ralph loop", or wants to fan out parallel agents across unblocked issues.
---

# Ralph Loop

A round-based loop that drains an issue backlog by spawning specialised subagents per issue, then merging them all together at the end of each round.

## Setup

Before the first round, read `AGENTS.md` (or `CLAUDE.md` as a fallback) at the repo root to discover:

- Where issues live (issue tracker / local markdown / etc.) and the commands to list, view, comment on, and close them
- How to run the typecheck and test commands
- Branch naming and source-branch conventions

If `AGENTS.md` is missing, ask the user once for the issue-tracker commands and the test/typecheck commands, then proceed. Pass these conventions into every subagent prompt — the subagents do not re-discover them.

## The Loop

Each round runs four phases. Repeat until no unblocked issues remain.

### Phase 1 — Plan (one agent)

Spawn **one Opus** subagent with [plan.md](plan.md). It returns a JSON list of unblocked issues, each with an assigned branch name, wrapped in `<plan>` tags. If the list is empty, the loop is done.

### Phase 2 — Implement (parallel, one per issue)

For every issue in the plan, spawn a **Sonnet** subagent with [implement.md](implement.md), filling in the issue id, title, and branch. These run **in parallel**.

Each implementer must rebase its branch on the current source branch before doing any work — this is enforced by the prompt. Each one does red→green TDD, commits with the project's commit conventions, and comments on its issue.

Wait for all implementers to finish before moving on.

### Phase 3 — Review (parallel, one per issue)

For every branch that came back from Phase 2, spawn a **Sonnet** subagent with [review.md](review.md), filling in the branch and source branch. These run **in parallel**.

Each reviewer checks deliverables against the issue, runs smoke tests, refactors for clarity, and commits any improvements.

Wait for all reviewers to finish.

### Phase 4 — Merge (one agent)

Spawn **one Opus** subagent with [merge.md](merge.md), passing the full list of branches and their issue ids. It merges them into the current branch sequentially, resolves any conflicts, runs the tests, and closes each merged issue.

### End-of-round check

After the merge agent returns, restart the loop from Phase 1. The new plan call will see the freshly closed issues and surface any that just became unblocked. When the planner returns zero issues, the loop exits.

## Subagent prompts

Each phase has a dedicated prompt file. Fill in the bracketed placeholders before spawning:

- [plan.md](plan.md) — `{{ISSUE_TRACKER_COMMANDS}}`
- [implement.md](implement.md) — `{{TASK_ID}}`, `{{ISSUE_TITLE}}`, `{{BRANCH}}`, `{{SOURCE_BRANCH}}`, `{{ISSUE_TRACKER_COMMANDS}}`, `{{TEST_COMMANDS}}`
- [review.md](review.md) — `{{BRANCH}}`, `{{SOURCE_BRANCH}}`, `{{TEST_COMMANDS}}`
- [merge.md](merge.md) — `{{BRANCHES}}`, `{{ISSUES}}`, `{{ISSUE_TRACKER_COMMANDS}}`, `{{TEST_COMMANDS}}`

## Termination

Stop the loop when any of these happens:

- The planner returns zero unblocked issues
- The merge agent reports an unresolvable conflict and the user has not given guidance
- The user interrupts

## Round summary

After each round, report concisely: how many issues were planned, how many merged successfully, how many remain open, and whether any newly unblocked issues will be picked up in the next round.
