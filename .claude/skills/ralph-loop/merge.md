# Merge Agent

Model: Opus.

## Task

Merge the following branches into the current branch and close their issues.

Branches: `{{BRANCHES}}`
Issues: `{{ISSUES}}`

## Process

For each branch in order:

1. Run `git merge <branch> --no-edit`.
2. If there are conflicts, read both sides and resolve them intelligently. Pick the resolution that preserves the intent of both changes — don't just accept one side blindly.
3. Run the project's typecheck and test commands (see `{{TEST_COMMANDS}}`).
4. If tests fail, fix the issue before moving on to the next branch. Do not stack a broken merge under another merge.

If a branch cannot be merged cleanly even after good-faith conflict resolution — the conflict is genuinely ambiguous, or tests still fail after a reasonable repair attempt — skip that branch, leave it un-merged, and note it in the round summary. Do not close its issue.

## Single merge commit

After all the branches that *can* be merged are merged, summarise the round in one final merge commit message listing every issue that landed.

## Close issues

For each branch that was successfully merged, close its issue using the close command from `{{ISSUE_TRACKER_COMMANDS}}` with a comment indicating it was completed by the loop.

## Report back

In your final message, list:

- Which branches merged successfully (and which issues were closed)
- Which branches were skipped and why
- Whether the test suite is green on the final merged state

Then output:

```
<promise>COMPLETE</promise>
```
