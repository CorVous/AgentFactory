Status: needs-triage

# `npm run mesh:cleanup -- --feature <slug>`

## Parent

[PRD-0001: Ralph-Loop mesh for AgentFactory V1](../PRD.md)

## What to build

A cleanup script that removes the kanban worktree (and any leftover per-issue worktrees) for a finished feature, keeping `<project>/.mesh-features/` from accumulating stale directories. Implementation §Mesh-worktree manager calls this out as a separate invocation rather than baking it into mesh shutdown — the user runs it explicitly when they're done with a feature.

- New script: `scripts/mesh-cleanup.mjs` (or wired as `npm run mesh:cleanup`).
- Invocation: `npm run mesh:cleanup -- --project <path> --feature <slug>`.
- Behaviour:
  1. Verify the launcher is being invoked from inside a worktree of `<project>` (same posture as the main launcher).
  2. Refuse to run if any Foreman process is alive against `<slug>` (probe by Kanban bus socket presence + a stale-pid check).
  3. `git worktree remove` the kanban worktree at `<project>/.mesh-features/<slug>/kanban/`.
  4. `git worktree remove` any per-issue worktrees at `<project>/.mesh-features/<slug>/foreman-*/`.
  5. Leave `feature/<slug>` and any per-issue branch refs untouched — branch cleanup is the user's responsibility (story #15: only abort/reject deletes refs).
  6. Leave `.scratch/<slug>/` untouched — it lives on `feature/<slug>` and gets carried into `main` when the user merges.
- Clear logging: list each worktree removed, each one skipped (with reason), and the final state.

## Acceptance criteria

- [ ] `npm run mesh:cleanup -- --project <path> --feature <slug>` exists and is documented in `docs/agents.md` (or wherever the launcher is documented post-#03).
- [ ] Script refuses outside a worktree.
- [ ] Script refuses when Kanban or any Foreman is alive against the feature; clear error tells the user to stop the mesh first.
- [ ] Script removes the kanban worktree and any per-issue worktrees under `<project>/.mesh-features/<slug>/`.
- [ ] Script does **not** delete `feature/<slug>` or any per-issue branch ref.
- [ ] Script does **not** touch `.scratch/<slug>/`.
- [ ] Hermetic unit test against a tmpdir git repo: prepare worktrees, run the script, assert worktrees are gone and branch refs survive.

## Blocked by

- #03 — AFK trunk end-to-end (the launcher and worktree layout this script cleans up land there)

## Comments
