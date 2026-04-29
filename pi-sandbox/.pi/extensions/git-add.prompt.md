# git_add — tool usage rules

Use `git_add` to stage files for the next commit in the per-issue worktree.

## Paths

- Pass a list of relative paths (relative to the worktree root).
- You may pass `"."` to stage all changes in the worktree.
- Absolute paths and paths containing `..` that escape the worktree root
  are rejected — this is a safety rail, not a limitation.

## Workflow position

`git_add` is Step 4 of the commit sub-flow:

1. Write/edit files.
2. `git_status` to see what changed.
3. `git_diff` to review changes.
4. `git_add` to stage the files to commit.
5. `git_diff` with `staged: true` to verify.
6. `git_commit` to record the commit.

## Prerequisite

`worktree_prepare` must have been called before this tool is available.
