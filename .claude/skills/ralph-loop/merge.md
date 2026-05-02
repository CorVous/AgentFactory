# Merge Agent

Model: Opus.

## Task

Merge the following branches into your worktree's HEAD and leave a tracking comment on each issue. **Do not close any issues** — that happens later, after the human merges the PR.

- Worktree: `{{WORKTREE}}`
- Branches: `{{BRANCHES}}`
- Issues: `{{ISSUES}}`

## Step 0 — Lock to your worktree

You have been given a fresh isolated worktree at `{{WORKTREE}}`, branched from the source branch. **Every command runs inside that directory.** Don't touch the main checkout or any of the per-issue worktrees still under `.ralph-worktrees/`.

```
cd {{WORKTREE}}
git status
```

## Process

For each branch in order:

1. Run `git merge <branch> --no-edit`.
2. If there are conflicts, read both sides and resolve them intelligently. Pick the resolution that preserves the intent of both changes — don't just accept one side blindly.
3. Run **typecheck + unit tests + smoke / integration tests** from `{{TEST_COMMANDS}}`. All three must pass.
4. If any test layer fails, fix the issue before moving on. Do not stack a broken merge under another merge.

If a branch cannot be merged cleanly even after good-faith conflict resolution — the conflict is genuinely ambiguous, or tests still fail after a reasonable repair attempt — `git merge --abort`, leave the branch un-merged, and note it in your final report. Leave a comment on the issue saying it was skipped this round and why.

## Single round-up commit

Once every mergeable branch is in, the worktree's history will already contain one merge commit per branch. That's fine — don't squash. Your final report will reference each branch's merge commit by SHA.

## Comment on issues (do not close)

For each branch that was successfully merged, leave a comment on its issue using the comment command from `{{ISSUE_TRACKER_COMMANDS}}`. The comment should include:

- The merge-commit SHA on the round branch
- The round number
- A note that the issue is awaiting human review and PR merge before it gets closed

The issue stays **open**. The human will run a separate close-out step ([close.md](close.md)) after they merge the PR.

## Final report

In your final message, list:

- Each merged branch with its merge-commit SHA and the issue id it's tied to
- Which branches were skipped and why
- The result of the final typecheck + unit + smoke run on the merged tip

Confirm explicitly that **no issues were closed** — they all stay open pending human review and PR merge.

Then output:

```
<promise>COMPLETE</promise>
```
