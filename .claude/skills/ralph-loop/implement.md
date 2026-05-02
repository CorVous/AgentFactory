# Implementation Agent

Model: Sonnet.

## Task

Fix issue `{{TASK_ID}}`: `{{ISSUE_TITLE}}` on branch `{{BRANCH}}`.

Only work on this single issue. Do not touch other issues.

## Step 0 — Lock to your worktree

You have been given an isolated git worktree at `{{WORKTREE}}`. **Every git, test, and file command you run must be inside that directory.** Do not `cd` to the main checkout. Do not touch other worktrees under `.ralph-worktrees/` — other agents are working there in parallel.

```
cd {{WORKTREE}}
git status   # confirm you're on {{BRANCH}}
```

## Step 1 — Force rebase before any work

Before reading any code or writing any tests:

```
git fetch
git rebase {{SOURCE_BRANCH}}
```

If the rebase produces conflicts, resolve them, complete the rebase, and only then continue. Skipping this step is not allowed — review and merge will fail without it.

## Step 2 — Pull in the issue

Use the issue-tracker commands from `{{ISSUE_TRACKER_COMMANDS}}` to fetch issue `{{TASK_ID}}`. If it has a parent PRD or epic, pull that in too so you have full context.

## Step 3 — Explore

Fill your context window with the parts of the codebase relevant to this issue. Pay extra attention to existing test files that touch the same areas — they show the project's testing conventions.

## Step 4 — Red → Green → Repeat (vertical slices)

Use red-green-refactor in **vertical slices**. One test, then one piece of implementation, then the next test.

Do **not** write all tests up front — that produces tests for imagined behaviour rather than actual behaviour, and they end up coupled to data shapes instead of user-facing behaviour.

The cycle:

1. **RED** — write one test that describes one observable behaviour through a public interface. Run it. Confirm it fails for the right reason.
2. **GREEN** — write the minimum code to make that one test pass. Nothing more.
3. **Repeat** — pick the next behaviour and go back to RED.
4. **REFACTOR** — only after all tests are green, look for duplication, deeper modules, and clearer names. Re-run tests after each refactor step.

Rules:

- One test at a time
- Tests describe behaviour, not implementation
- Tests use public interfaces only
- Don't anticipate future tests
- Never refactor while red

## Step 5 — Feedback loop

Before committing, run the project's typecheck and unit-test commands (see `{{TEST_COMMANDS}}`). Both must pass. Smoke / integration tests are run later by the merge agent — you don't need to run them here.

## Step 6 — Commit

Make a single git commit. The commit message must:

1. Reference the issue id and any parent PRD
2. Note key decisions made
3. List the files changed
4. Flag any blockers or follow-ups for the next iteration

Keep it concise.

## Step 7 — Update the issue

Leave a comment on issue `{{TASK_ID}}` summarising what was done. **Do not close the issue** — the merge agent will do that later.

## Done

Once the commit is in and the issue is commented, output:

```
<promise>COMPLETE</promise>
```

## Final rules

- Only work on a single issue.
- Stay inside `{{WORKTREE}}` for the entire run.
- Never push, never open a PR, never close the issue.
- If you genuinely cannot complete the task (missing dependency, ambiguous spec), comment that on the issue and still output `<promise>COMPLETE</promise>` so the loop continues.
