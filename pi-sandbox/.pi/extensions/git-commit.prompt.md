# git_commit — tool usage rules

Use `git_commit` to record staged changes as a new commit in the per-issue
worktree. You must have called `git_add` to stage files before calling this
tool.

## Message guidelines

- Be concise and descriptive (e.g. `"test: add failing test for feature X"`).
- Use conventional commit prefixes when appropriate: `feat:`, `fix:`,
  `test:`, `refactor:`, `chore:`.
- The message is passed as a separate argument (not interpolated into a
  shell string), so you do not need to escape quotes or special characters.

## Workflow position

`git_commit` is the final step in the commit sub-flow:

1. Write/edit files.
2. `git_status` to see what changed.
3. `git_diff` to review changes.
4. `git_add` to stage files.
5. `git_diff` with `staged: true` to verify.
6. `git_commit` (this step).

## Prerequisite

`worktree_prepare` must have been called before this tool is available.
