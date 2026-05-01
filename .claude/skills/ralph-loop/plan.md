# Planning Agent

Model: Opus.

## Task

Build a dependency graph of all open issues and return the ones that are unblocked.

## Discover issues

Use the issue-tracker commands defined in `AGENTS.md` (or whatever was passed in via `{{ISSUE_TRACKER_COMMANDS}}`) to list every open issue with its number, title, body, labels, and comments.

## Build the dependency graph

For every issue, decide whether it is **blocked by** any other open issue. Issue B is blocked by issue A when:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** when it has zero blocking dependencies on other open issues.

## Output

Assign each unblocked issue a branch name using the format `ralph/issue-{id}-{slug}` where `{slug}` is a short kebab-case version of the title.

Emit your plan as a JSON object wrapped in `<plan>` tags. Include only unblocked issues:

```
<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "ralph/issue-42-fix-auth-bug"}]}
</plan>
```

If every open issue is blocked, include the single highest-priority candidate — the one with the fewest or weakest dependencies — so the loop still makes progress.

If there are zero open issues at all, emit:

```
<plan>
{"issues": []}
</plan>
```

This signals the orchestrator that the loop is done.
