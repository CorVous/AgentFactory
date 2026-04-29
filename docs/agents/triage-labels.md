# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

These are **pre-work** states only — they describe how an issue has been triaged, not whether it's been worked on or completed. The full lifecycle (open → claimed → closed) and its non-triage states are defined in `issue-tracker.md`.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent (auto-merge on completion) |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation (PR-pause on completion) |
| `wontfix`                  | `wontfix`            | Will not be actioned (terminal — file moves to `issues/closed/`) |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

For local-markdown trackers, the label string goes in the issue file's `Status:` line (see `issue-tracker.md`). The `ready-for-agent` vs `ready-for-human` distinction also drives the per-issue workflow at completion time (auto-merge vs PR), so pick the right one when triaging.

Edit the right-hand column to match whatever vocabulary you actually use.
