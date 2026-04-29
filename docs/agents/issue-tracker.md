# Issue tracker: Local Markdown

Issues and PRDs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md`
- Open implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Closed issues are moved (via `git mv`, preserving history) to `.scratch/<feature-slug>/issues/closed/<NN>-<slug>.md`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Inter-issue dependencies are recorded as an optional `Depends-on:` line listing the path(s) of blocking issues
- The agent or human currently working on an issue is recorded as an optional `Claimed-by:` line; absence of this line means the issue is unclaimed
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## Lifecycle

An issue file moves through three states. The directory it lives in plus its `Status:` and `Claimed-by:` lines together encode the state:

| State    | Directory               | `Status:`                | `Claimed-by:` | Meaning                                       |
| -------- | ----------------------- | ------------------------ | ------------- | --------------------------------------------- |
| Open     | `issues/`               | a triage role (see below) | absent        | Triaged but not yet picked up                 |
| Claimed  | `issues/`               | unchanged                | present       | An agent or human has started work            |
| Closed   | `issues/closed/`        | `closed` (or `wontfix`)  | absent or stale | Work is done (or won't be done)             |

Triage roles for the open state come from `triage-labels.md`. The two values that are valid in the closed state (`closed`, `wontfix`) are not triage roles — they're terminal states.

## Per-issue workflow

When work starts on an issue, a feature branch is created off the *workflow branch* — the branch the surrounding workflow (Sandcastle, Ralph-Loop mesh, manual session) is running on. The branch is named `feature/<feature-slug>-<NN>-<slug>`, derived from the issue's path.

How the branch reintegrates depends on the issue's triage role at the moment work started:

- **`ready-for-agent` (AFK)** — on completion, the feature branch auto-merges back into the workflow branch. No human review. The issue file is then moved to `issues/closed/` with `Status: closed` in the same commit (or follow-up commit) on the workflow branch.

- **`ready-for-human` (HITL)** — on completion, the feature branch is pushed and a pull request is opened against the workflow branch. The workflow pauses. When the human merges the PR, the issue is moved to `issues/closed/` with `Status: closed`.

Issues with `Status: needs-triage` or `Status: needs-info` are not picked up automatically — they require triage action first. Issues with `Status: wontfix` are moved straight to `issues/closed/` without a feature branch.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/issues/` (creating the directory if needed). For PRDs, write to `.scratch/<feature-slug>/PRD.md`.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly. Closed tickets live under `issues/closed/`.

## When a skill says "close the issue"

1. `git mv .scratch/<feature-slug>/issues/<NN>-<slug>.md .scratch/<feature-slug>/issues/closed/<NN>-<slug>.md`
2. Edit the moved file: change the `Status:` line to `Status: closed` (or `Status: wontfix` if the issue won't be actioned).
3. Append a closing note under the `## Comments` heading (creating the heading if it doesn't exist).
