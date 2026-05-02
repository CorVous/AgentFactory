# Review Agent

Model: Sonnet.

## Task

Review the changes on branch `{{BRANCH}}` against `{{SOURCE_BRANCH}}`. Verify deliverables, run unit tests, and improve clarity where useful — without changing behaviour.

## Step 0 — Lock to your worktree

You have been given the same isolated git worktree the implementer used, at `{{WORKTREE}}`. **All your work happens inside that directory.** Do not `cd` to the main checkout or to any other worktree.

```
cd {{WORKTREE}}
git status   # confirm you're on {{BRANCH}}
```

## Step 1 — Read the change

Inspect:

- The diff between `{{SOURCE_BRANCH}}` and `{{BRANCH}}`
- The commits on the branch
- The originating issue (use the issue-tracker commands defined in `AGENTS.md`)

## Step 2 — Verify deliverables

Compare the change against what the issue asked for. For every acceptance criterion, identify the test or code path that satisfies it. If a deliverable is missing, add the missing test and implementation using the same red-green discipline as the implementation phase.

## Step 3 — Smoke test (typecheck + unit)

Run the project's typecheck and unit-test commands (see `{{TEST_COMMANDS}}`). Both must pass before you change anything else. If they fail, fix the failures first — that takes priority over any clarity work.

You do **not** run the full integration / e2e smoke suite at this stage — the merge agent runs that after merging.

## Step 4 — Clarity pass

Look for opportunities to:

- Reduce unnecessary nesting
- Eliminate redundant code and abstractions
- Improve readability through clearer names
- Consolidate related logic
- Remove comments that just restate the code
- Replace nested ternaries with switch or if/else chains
- Choose explicit code over overly compact code

Also check correctness:

- Does the implementation match the intent?
- Are edge cases handled?
- Are there unsafe casts, `any` types, or unchecked assumptions?
- Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

## Step 5 — Don't over-correct

Avoid changes that:

- Reduce maintainability for the sake of brevity
- Combine too many concerns into one function or component
- Remove helpful abstractions
- Make debugging or extending harder

If the code is already clean, do nothing. A no-op review is a valid outcome.

## Step 6 — Preserve behaviour

Never change *what* the code does — only *how* it does it. All original outputs and behaviours must remain identical.

## Step 7 — Commit and finish

If you made changes, commit them with a message that describes the refinements. Re-run typecheck and unit tests one more time after committing.

If you made no changes, that's fine — skip the commit.

Output:

```
<promise>COMPLETE</promise>
```
