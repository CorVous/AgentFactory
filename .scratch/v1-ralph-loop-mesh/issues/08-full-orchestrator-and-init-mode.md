Status: ready-for-human

# Full Orchestrator (grill → PRD → issues) + launcher `--init` mode

## Parent

[PRD-0001: Ralph-Loop mesh for AgentFactory V1](../PRD.md)

## What to build

Upgrade the thin Orchestrator (#02) into the real PRD-and-issues authoring agent, and wire the launcher's `--init` mode so going from "I have an idea" to "PRD + issues drafted on the feature branch" is a single command. Stories #2d, #2e, #2f, #2g.

### Full Orchestrator (`pi-sandbox/agents/ralph/orchestrator.yaml`)

- `LEAD_HARE_MODEL` tier, interactive.
- Tools palette: `read`, `grep`, `find`, `glob`, `deferred_write`. No `bash`, no `delegate`. Not part of the mesh runtime.
- Prompt drives a grill session (Pocock-style) — interview the user about the feature, surface unknowns, propose framings — then writes:
  - `.scratch/<feature-slug>/PRD.md` matching the existing PRD template / shape (anchors + Problem Statement + Solution + User Stories + Implementation Decisions + Testing Decisions + Out of Scope + Further Notes).
  - `.scratch/<feature-slug>/issues/<NN>-<slug>.md` files: thin vertical-slice issues (the same shape this PRD's #02 produces, only multiple at once and informed by the grill).
- All file output goes through `deferred_write` so the user reviews the diff at end-of-turn before anything is committed (story #2e). The user commits manually after approval.
- Hermetic test: feed a fixture grill transcript to the recipe, inspect the deferred-write queue. Assert PRD.md is well-formed (sections present, anchors set), issue files have `Status:` lines, `Depends-on:` references resolve, ordering is sensible.

### Launcher `--init` mode

- `npm run mesh -- --project <path> --feature <slug> --init`:
  1. Verify the launcher is being invoked from inside a worktree of `<project>` (same check as runtime mode in #03).
  2. Ensure `.mesh-features/` is in `<project>`'s `.gitignore` on `main`. If the line is already present, skip. If absent and `main`'s tree is clean, add the line and create a single auto-commit on `main` (the **only** time the mesh ever touches `main`). If absent and `main` has unstaged changes that would be swept into the auto-commit, fail loudly with a clear message asking the user to stage / stash / commit first; do not silently proceed.
  3. Create `feature/<slug>` off `main` (if absent) and `git worktree add` it at `<project>/.mesh-features/<slug>/kanban/` (if absent).
  4. Spawn the full Orchestrator interactively in the new worktree. Exit when the Orchestrator's pi session ends.
- The user reviews the deferred-write diff, commits the PRD + issues themselves on `feature/<slug>`, then re-invokes without `--init` to start the Kanban runtime (#03).

### Acceptance: live-model demo

This is HITL because (a) the grill prompt design is a judgment call only a human reviewer can validate against the feel of a real session, and (b) the `.gitignore`-on-`main` auto-commit UX needs a human eye. Run a tmux integration session: invoke `--init` against a fixture project; play the user role in the grill; review the deferred-write diff; approve; commit; re-invoke the launcher in runtime mode and confirm the Kanban dispatches against the produced issues.

## Acceptance criteria

- [ ] Full Orchestrator recipe loads under `npm run agent --` without erroring.
- [ ] Hermetic unit test against a fixture grill transcript inspects the deferred-write queue: `PRD.md` has the canonical section structure, issue files have `Status:` lines and well-formed `Depends-on:` references.
- [ ] Launcher `--init` refuses outside a worktree (clear message).
- [ ] Launcher `--init` adds `.mesh-features/` to `.gitignore` on `main` with a single auto-commit when absent and tree is clean.
- [ ] Launcher `--init` fails loudly with a clear actionable message when `.gitignore` would need editing but `main` is dirty.
- [ ] Launcher `--init` creates `feature/<slug>` off `main` and the kanban worktree, then execs the Orchestrator interactively in the worktree.
- [ ] Launcher exits cleanly when the Orchestrator session ends; a follow-up runtime-mode invocation (without `--init`) dispatches against the produced issues.
- [ ] Live-model tmux integration: reviewer plays the user role, judges the grill quality, approves the deferred-write diff, commits, runs runtime mode, watches the AFK / HITL trunks (#03 / #04) work the produced issues. Reviewer signs off on the grill UX and the auto-commit UX.

## Blocked by

- #02 — thin Orchestrator (the deferred-write recipe shape and the issue-file template land there; this issue extends them)
- #03 — AFK trunk end-to-end (the launcher's runtime-mode plumbing this issue branches off)

## Comments
