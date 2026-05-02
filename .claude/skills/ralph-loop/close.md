# Close-Out Agent

Model: Sonnet.

## When to run this

Run this agent **after**:

1. The Ralph loop has finished and produced `RALPH_QA.md`
2. A human has worked through the QA checklist and signed off
3. A human has merged the round's PR into the long-lived branch (typically `main`)

If any of those is not yet true, do not run this agent — the issues should stay open.

## Task

Close every issue listed in `{{ISSUES}}`, citing the commit that solved it.

## Inputs

- `{{ISSUES}}` — list of `{id, branch, merge_commit}` objects, the same data the merge agent reported in its final message and that's referenced in `RALPH_QA.md`
- `{{PR_NUMBER}}` (optional) — the PR the human just merged, if applicable
- `{{ISSUE_TRACKER_COMMANDS}}` — the close + comment commands from `AGENTS.md`

## Step 1 — Verify the merge actually landed

Before touching any issues, confirm each `merge_commit` SHA is reachable from the long-lived branch:

```
git fetch
git merge-base --is-ancestor {merge_commit} origin/{long_lived_branch}
```

If a commit is **not** reachable — the human cherry-picked some changes but not others, or the PR was reverted — do not close that issue. List it in your final report as "skipped: commit not on main".

## Step 2 — Close each issue with a commit reference

For every issue whose commit is reachable, close it with a comment that names the exact commit. The comment template:

```
Resolved by commit {merge_commit}{ pr_suffix }.

Implemented and reviewed in Ralph round {round_number}; merged to {long_lived_branch} by human after QA sign-off.
```

Where `pr_suffix` is ` (PR #{{PR_NUMBER}})` if a PR number was supplied, otherwise empty.

Use the close command from `{{ISSUE_TRACKER_COMMANDS}}` to both post the comment and close the issue in one step if the tracker supports that. Otherwise post the comment first, then close.

## Step 3 — Report

List every issue you closed with its commit SHA, plus any issues you skipped and why.

Output:

```
<promise>COMPLETE</promise>
```

## Rules

- Never close an issue whose commit isn't on the long-lived branch.
- Never close an issue that the merge report flagged as skipped.
- If `RALPH_QA.md` is missing or the human hasn't signed off, stop and ask before closing anything.
