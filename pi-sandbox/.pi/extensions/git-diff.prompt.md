# git_diff — tool usage rules

Use `git_diff` to inspect changes in the per-issue worktree.

- `staged: false` (default) — shows unstaged changes (`git diff`). Use
  this to review edits before staging them with `git_add`.
- `staged: true` — shows staged changes (`git diff --staged`). Use this
  to review what is queued for the next commit before calling `git_commit`.

## Workflow position

Typical usage in the Ralph Loop:

1. Write or edit files.
2. `git_diff` (unstaged) to review changes.
3. `git_add` to stage the files you want to commit.
4. `git_diff` with `staged: true` to confirm the staged set.
5. `git_commit` to record the commit.

## Prerequisite

`worktree_prepare` must have been called before this tool is available.
