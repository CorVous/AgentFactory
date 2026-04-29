# run_tests — tool usage rules

Use `run_tests` to execute the project's automated test suite inside the
per-issue worktree. This tool is **only available after `worktree_prepare`
has been called** — calling it before the worktree exists will return an
error.

## V1 constraint

`run_tests` runs `npm test` and is therefore **restricted to Node/npm
projects**. Non-Node projects are out of scope for V1; the Podman
containerisation story (long-term) will generalise this.

## Interpreting results

- `exitCode: 0` — all tests passed; continue to the commit step.
- `exitCode: non-zero` — at least one test failed. Read the `stdout` and
  `stderr` fields to understand what broke, then fix and re-run.

## Workflow position

Call `run_tests` during the Ralph Loop (Step 4d) after writing or fixing
code. Keep running until `exitCode` is `0` before proceeding to Step 5.
