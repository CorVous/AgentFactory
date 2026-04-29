# git_mv — tool usage rules

Use `git_mv` to rename or move a tracked file inside the per-issue worktree.
The operation is recorded as a rename in git history (not a delete+add), so
it's the right tool for moves like `issues/01-x.md → issues/closed/01-x.md`.

## Paths

- Both `src` and `dst` are relative to the worktree root.
- Absolute paths and paths containing `..` that escape the worktree root
  are rejected.
- The destination's parent directory is created automatically.

## Workflow position

`git_mv` records the move in the worktree's index. Stage the result with
`git_status` to verify, then `git_commit` to record. You do **not** need a
separate `git_add` after `git_mv` — the move is already staged.

## Prerequisite

`worktree_prepare` must have been called before this tool is available.
