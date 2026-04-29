Status: ready-for-agent

# Depends-on filter (blocked issues invisible to Kanban)

## Parent

[PRD-0001: Ralph-Loop mesh for AgentFactory V1](../PRD.md)

## What to build

Make the Kanban skip issues whose `Depends-on:` line lists any open (non-closed) issue, so no Foreman is spawned for work that depends on something incomplete (story #19). The issue-tracker convention (`docs/agents/issue-tracker.md`) already specifies the `Depends-on:` line shape; this issue wires it into the Kanban's spawn-decision pure function.

- Extend the spawn-decision pure function: an issue is selectable only if every path listed in its `Depends-on:` line resolves to a closed issue (i.e., file lives under `issues/closed/` with `Status: closed` or `Status: wontfix`).
- A `Depends-on:` line referring to a non-existent path is a hard skip with a clear log line (story #26-style log) so the user can fix the typo. Do not crash the Kanban.
- Combined with the issue-watcher (#05), an `issue-blocked-cleared` transition wakes the Kanban and the now-unblocked issue is selected on the re-scan.

## Acceptance criteria

- [ ] Spawn-decision pure-function unit tests cover: blocked issue skipped, unblocked issue selected, transitively-blocked issue skipped (A depends on B depends on C, only A and B are closed → C blocks itself trivially? clarify: an issue depending on a still-open issue is skipped; a closed issue is never selectable for dispatch anyway), `Depends-on:` referencing a non-existent path skipped with a logged warning, missing `Depends-on:` line treated as no dependencies.
- [ ] Kanban logs a clear line for each skip-due-to-unmet-dependency (story #26 visibility).
- [ ] Manual verification with a two-issue fixture: `02-x.md` declares `Depends-on: 01-y.md`. While `01-y.md` is open, only `01-y.md` dispatches. After `01-y.md` closes, `02-x.md` becomes selectable on the next wake.
- [ ] No change to issue-file format; the existing `Depends-on:` convention is the schema.

## Blocked by

- #03 — AFK trunk end-to-end (Kanban + spawn-decision land there)

## Comments
