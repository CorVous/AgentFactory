---
name: ralph-one
description: Complete a single user-specified issue end-to-end — Opus plans, Sonnet implements/reviews in a loop, Opus runs an integration smoke, then opens a PR and closes the issue when the human merges. Use when the user names one issue to take from triage to merged, sequentially (no parallelism, no worktree).
---

# Ralph (single issue)

Inputs: `{{ISSUE_ID}}` (the user gives you this).

Plan once with Opus, then loop implement → review with Sonnet until the
reviewer approves. Work on the issue's branch in the main checkout — no
worktree. On approval, Opus runs an integration smoke, writes the hand-off
note, opens a PR, and closes the issue once the human merges.

## Setup

Read `AGENTS.md` (fallback `CLAUDE.md`) for:

- Issue-tracker commands (list / view / comment / close)
- Typecheck, unit-test, integration/smoke commands
- Branch naming and source-branch conventions

If missing, ask the user once.

Set `MAX_ATTEMPTS = 5` (cap on implement↔review cycles).

## Phase 1 — Load the issue

Use the issue-tracker commands to fetch issue `{{ISSUE_ID}}`: title, body,
labels, comments. If it's already closed, stop and tell the user.

Derive `{branch} = "ralph/issue-{{ISSUE_ID}}-{slug-of-title}"` (or whatever
the project's branch convention dictates).

## Phase 2 — Plan (one Opus subagent, read-only, no commits)

Spawn an Opus subagent with this brief:

> You are the planner for issue `{{ISSUE_ID}}` (`{{ISSUE_TITLE}}`).
> Read the issue body + comments and the relevant code. Produce an
> implementation plan as a numbered list of concrete steps:
>
> - Files to create/modify (paths)
> - Tests to add (paths + what they verify)
> - Any open questions for the human (only if blocking)
>
> Do NOT write code or make commits. Output the plan in `<plan>…</plan>`
> tags.

If the planner returns blocking open questions, surface them to the user and
stop. Otherwise capture the plan as `{{PLAN}}` for downstream phases.

## Phase 3 — Create the working branch

```sh
git switch -c {branch} {source_branch}
```

(Or `git switch {branch}` if it already exists from an earlier run.)

## Phase 4 — Implement ↔ review loop

```
attempt = 1
review_feedback = null

while attempt <= MAX_ATTEMPTS:
```

### Implement (one Sonnet subagent)

Spawn the implementer with `.claude/skills/ralph-loop/implement.md`,
substituting `{{TASK_ID}}={{ISSUE_ID}}`, `{{ISSUE_TITLE}}`, `{{BRANCH}}`,
`{{SOURCE_BRANCH}}`, `{{ISSUE_TRACKER_COMMANDS}}`, `{{TEST_COMMANDS}}`.
Drop the `{{WORKTREE}}` placeholder — it works in the main checkout on
`{branch}`.

Append to its task:

> Implementation plan from the planner (follow it; deviate only with a
> written justification in the commit body):
> `{{PLAN}}`

If `review_feedback` is set, also append:

> Reviewer feedback from previous attempt — address before continuing:
> `<feedback>`

Wait for it to commit and return.

### Review (one Sonnet subagent)

Spawn the reviewer with `.claude/skills/ralph-loop/review.md`, substituting
`{{BRANCH}}`, `{{SOURCE_BRANCH}}`, `{{TEST_COMMANDS}}`. Drop `{{WORKTREE}}`.
Pass the planner's `{{PLAN}}` as context so it can check fidelity.

Ask it to end its response with exactly one of:

- `APPROVED`
- `REJECTED: <specific, actionable feedback>`

If `APPROVED` → break.
If `REJECTED` → `review_feedback = the feedback`; `attempt += 1`; continue.

If the loop exits because `attempt > MAX_ATTEMPTS`:
comment on the issue with the last review feedback, leave the branch as-is,
and tell the user the cap was hit so they can intervene.

## Phase 5 — Integration smoke (one Opus subagent)

Spawn an Opus subagent on `{branch}` with this brief:

> You are doing a live integration smoke for issue `{{ISSUE_ID}}`
> (`{{ISSUE_TITLE}}`). Branch under test: `{branch}`.
>
> 1. Run the project's full integration / smoke command end-to-end.
> 2. Exercise the actual code path the issue describes (don't just trust
>    the unit tests — drive the feature/bug-fix path live: hit the
>    endpoint, run the CLI, open the page, etc.).
> 3. Probe the obvious adjacent regressions.
>
> Output one of:
>
> - `SMOKE PASSED: <one-line summary of what you exercised>`
> - `SMOKE FAILED: <reproduction steps + observed vs. expected>`

If `SMOKE FAILED` → re-enter Phase 4 with the smoke failure as
`review_feedback` (counts toward `MAX_ATTEMPTS`). If still failing after
the cap, comment the failure on the issue and stop without opening a PR.

## Phase 6 — Hand-off note + PR (Opus)

On smoke pass, Opus produces the hand-off artifact. The note has three
sections:

### What this fixes

A short paragraph explaining the actual change — the cause of the bug or
the shape of the new feature, and how the diff addresses it. Reference
files + symbols, not just the diff.

### QA steps for the human

Concrete steps the human should run to verify (or "None — fully covered
by the integration smoke" if there's genuinely nothing a human adds).
Skip anything the automated tests already prove.

### Automated coverage

One line listing the typecheck / unit / smoke commands that passed.

Then:

1. `git push -u origin {branch}`
2. Open a PR using the project's PR command. Title: the issue title.
   Body: the hand-off note above, with a `Closes #{{ISSUE_ID}}` trailer
   so the issue auto-references the PR.
3. Comment on the issue: `PR #<pr-number> opened against {branch} —
   awaiting human review.`
4. Report the PR URL to the user and wait.

## Phase 7 — Close-out (after the human merges the PR)

Triggered when the user signals the PR has merged (or you observe the
merge via the issue tracker / PR API).

1. Verify the merge commit is reachable from the long-lived branch.
2. Close issue `{{ISSUE_ID}}` with a comment:
   `Resolved by PR #<pr-number> (merge commit <sha>).`
3. Stop.

## Termination

Stop when any of:

- planner surfaces a blocking question
- `MAX_ATTEMPTS` reached without approval (escalate to human)
- smoke fails `MAX_ATTEMPTS` times (escalate to human, no PR)
- PR opened and human takes over (resume at Phase 7 on merge)
- the user interrupts
