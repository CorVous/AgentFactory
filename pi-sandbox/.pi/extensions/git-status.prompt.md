# git_status — tool usage rules

Use `git_status` to inspect the current state of the per-issue worktree.
The output is `git status --porcelain` format: two-character status codes
followed by file paths (empty output means a clean tree).

## When to use

- Before `git_add` to confirm which files have changed.
- After `git_commit` to verify the tree is clean.
- At any point in the Ralph Loop when you need to check what has changed.

## Prerequisite

`worktree_prepare` must have been called before this tool is available.
