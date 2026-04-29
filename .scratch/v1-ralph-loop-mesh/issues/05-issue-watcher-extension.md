Status: ready-for-agent

# issue-watcher extension (wake replaces polling)

## Parent

[PRD-0001: Ralph-Loop mesh for AgentFactory V1](../PRD.md)

## What to build

Replace the Kanban's polling loop (placeholder from #03) with a filesystem-watch extension that emits bare `wake` envelopes when the issue tree changes in a relevant way. The Kanban re-scans on each wake; no per-event payload routing in V1 (story #29's typed-event variants are deferred). The end-user-visible effect: adding or editing an issue file triggers Kanban dispatch without restarting anything, and a blocker being cleared (the dependency issue closing) wakes any blocked sibling (story #18).

### Extension shape

- New extension at `pi-sandbox/.pi/extensions/issue-watcher.ts` (top level — universal, used by the Ralph stack only in V1 but lives outside `deferred/`).
- Watches `.scratch/<feature-slug>/issues/` (the feature slug comes from a CLI flag set by the launcher / Kanban).
- Uses `fs.watch` (or equivalent) — no external deps.
- A pure-function transition detector (`detectTransitions(prevSnapshot, nextSnapshot) → Transition[]`) compares two parsed snapshots of issue-file metadata and emits transitions for the events the Kanban cares about: `issue-ready`, `issue-blocked-cleared`, `issue-closed`. The detector is stateless; the extension owns the snapshot-stash.
- On each detected transition, the extension sends a bare `wake` envelope to the Kanban peer (target peer name configurable; defaults to the Kanban's stable name from the launcher).

### Kanban integration

- Kanban registers a bus handler for `wake`; the body is opaque in V1 (just a notification). On receipt the Kanban runs the same scan-and-dispatch path it ran on its polling tick in #03.
- The polling-tick fallback from #03 is removed (or kept at a very long interval as a safety net — author's call, document the choice).

## Acceptance criteria

- [ ] `pi-sandbox/.pi/extensions/issue-watcher.ts` exists and registers an `fs.watch` on `.scratch/<feature-slug>/issues/`.
- [ ] Pure-function `detectTransitions` is unit-tested against snapshot fixtures: emits `issue-ready` when an issue's `Status:` flips to `ready-for-agent` or `ready-for-human`; emits `issue-blocked-cleared` when a depended-on issue closes; emits `issue-closed` when an issue moves to `issues/closed/`. False-negative cases (e.g., comment-only edits) emit nothing.
- [ ] On any transition, the extension sends a `wake` envelope to the configured Kanban peer.
- [ ] Kanban receives `wake` and runs the same dispatch logic from #03; no polling tick is required for end-to-end functionality.
- [ ] Adding a fixture issue file via the thin Orchestrator (#02) triggers a Kanban dispatch without restarting the mesh.
- [ ] No live-model dependency in the unit tests; integration with the mesh is verifiable via the existing tmux pattern but is not required for this issue's acceptance.

## Blocked by

- #03 — AFK trunk end-to-end (Kanban exists, polling placeholder is in place to be replaced)

## Comments
