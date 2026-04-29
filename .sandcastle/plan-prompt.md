# ISSUES

Issues live as markdown files under `.scratch/<feature-slug>/issues/<NN>-<slug>.md` (see `docs/agents/issue-tracker.md`). Sandcastle is the **AFK** path: it only picks up issues with `Status: ready-for-agent`. Issues with `Status: ready-for-human` (HITL) follow a different workflow — they pause for a PR review and are not in scope here.

Here are the paths of `ready-for-agent` issue files in the repo:

<ready-for-agent-paths>

!`grep -l '^Status: ready-for-agent' .scratch/*/issues/*.md 2>/dev/null`

</ready-for-agent-paths>

Read each path (and any sibling `PRD.md`) to learn the issue's title, status, dependencies (from any `Depends-on:` line), and acceptance criteria.

# TASK

Analyze the open issues and build a dependency graph. For each issue, determine whether it **blocks** or **is blocked by** any other open issue.

An issue B is **blocked by** issue A if:

- B's `Depends-on:` line names A
- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on other open issues.

The issue's `id` is its path relative to the repo root (e.g., `.scratch/v1-ralph-loop-mesh/issues/01-kanban-script.md`). For each unblocked issue, assign a branch name using the format `sandcastle/<feature-slug>-<NN>-<slug>` (derived from the path).

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": ".scratch/v1-ralph-loop-mesh/issues/01-kanban-script.md", "title": "Kanban script — non-LLM peer", "branch": "sandcastle/v1-ralph-loop-mesh-01-kanban-script"}]}
</plan>

Include only unblocked issues. If every issue is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).
