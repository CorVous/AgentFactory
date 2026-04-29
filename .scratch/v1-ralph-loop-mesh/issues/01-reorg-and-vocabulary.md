Status: ready-for-agent

# Directory reorg + CONTEXT.md vocabulary

## Parent

[PRD-0001: Ralph-Loop mesh for AgentFactory V1](../PRD.md)

## What to build

Move the deferred-* stack into a clearly-labelled subdirectory so it can coexist with the new Ralph-Loop stack on the same protocol layer, and record the construction-site vocabulary in `CONTEXT.md` so downstream issues have a stable shared glossary.

- Move `deferred-write`, `deferred-edit`, `deferred-move`, `deferred-delete`, `deferred-confirm`, `sandbox`, `no-edit`, `atomic-delegate` to `pi-sandbox/.pi/extensions/deferred/`.
- Move recipes that depend on the deferred-* stack (`deferred-writer`, `deferred-author`, `deferred-editor`, `writer-foreman`, `delegator`, `peer-chatter`, `mesh-*`) to `pi-sandbox/agents/deferred/`.
- Update `CONTEXT.md` to add **Kanban**, **Foreman**, **Worker**, **Ralph Loop**, and **Project** to the domain glossary alongside the existing **Recipe** / **Role** / **Peer** / **Tier** / **Habitat** entries. Flag legacy uses of "worker" (e.g., in ADR-0001 referring to the Atomic Delegate child sense) under the Flagged ambiguities section.
- Cross-reference ADR-0001, ADR-0002, ADR-0003, ADR-0004, and ADR-0005 from the PRD and from each new module that lands in subsequent issues.

Pure reorg + docs — no behaviour change.

## Acceptance criteria

- [ ] `pi-sandbox/.pi/extensions/deferred/` contains all eight listed extensions; the originals are gone from the top level.
- [ ] `pi-sandbox/agents/deferred/` contains all listed recipes; the originals are gone from the top level.
- [ ] All in-tree references to the moved paths (in scripts, tests, docs, recipe `extensions:` lists) resolve to the new locations.
- [ ] Existing unit tests (`npm test`) and the deferred-stack tmux integration patterns in `docs/agents.md` still pass against the new layout.
- [ ] `CONTEXT.md` has Kanban, Foreman, Worker, Ralph Loop, and Project domain entries, plus a Flagged-ambiguities note about legacy "worker" usage in ADR-0001.
- [ ] ADR-0001 / 0002 / 0003 / 0004 / 0005 are referenced from `.scratch/v1-ralph-loop-mesh/PRD.md` (already present) and the new domain entries.

## Blocked by

None — can start immediately.
