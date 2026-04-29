Status: needs-triage

# Thin Orchestrator (minimum to make issues appear)

## Parent

[PRD-0001: Ralph-Loop mesh for AgentFactory V1](../PRD.md)

## What to build

A minimal pi recipe that produces well-formed issue files via deferred-write, so that downstream Kanban/Foreman work (issues #03 and #04) can be QA'd without hand-authoring markdown. This is the planning-time precursor in its smallest form: it does **not** run a grill session and does **not** author a PRD — that's the full Orchestrator's job (issue #08).

- New recipe: `pi-sandbox/agents/ralph/orchestrator-thin.yaml` (or equivalent path), `LEAD_HARE_MODEL` tier.
- Tools palette: `read`, `grep`, `find`, `glob`, `deferred_write`.
- Given a free-form description ("create a `ready-for-agent` issue titled X with body Y"), it writes a well-formed `.scratch/<feature-slug>/issues/<NN>-<slug>.md` file containing the canonical preamble (`Status: ready-for-agent` or `ready-for-human`, optional `Depends-on:`) plus a body, and queues it for end-of-turn deferred-write approval.
- Filename numbering follows the issue-tracker convention (next available `NN`, two-digit, zero-padded).

The recipe does not delegate, does not run the mesh, and is not part of the mesh runtime. It just produces input files that the Kanban (issue #03) can later dispatch against.

## Acceptance criteria

- [ ] Recipe loads under `npm run agent -- ralph/orchestrator-thin --sandbox <tmpdir>` without erroring.
- [ ] Hermetic unit test inspects the deferred-write queue for a fixture prompt and asserts the resulting file path, `Status:` line, optional `Depends-on:` line, and body shape match the issue-tracker conventions in `docs/agents/issue-tracker.md`.
- [ ] Approving the deferred-write dialog produces a file at the expected path; the file is well-formed enough that the human can `git add && git commit` without further editing.
- [ ] The recipe's `prompt:` documents that this is the thin variant and points at issue #08 for the full grill→PRD→issues flow.

## Blocked by

- #01 — directory reorg + CONTEXT.md vocabulary

## Comments
