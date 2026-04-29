Status: ready-for-human

# AFK trunk end-to-end (happy path)

## Parent

[PRD-0001: Ralph-Loop mesh for AgentFactory V1](../PRD.md)

## What to build

The full AFK Ralph-Loop happy path, demoable end-to-end against a real project: a developer drops a `ready-for-agent` issue (via the thin Orchestrator from #02) and the mesh works it from claim to merge to close without human interaction. This is one tracer-bullet vertical slice that cuts through the launcher, the Kanban control plane, the Foreman recipe, the per-issue worktree manager, and the issue-close step.

> **Scope note** — this is the *slimmed* tracer bullet. Failure paths (Foreman test-fail / abort cleanup, deletion of stale per-issue branch refs) and launcher hardening (refusing outside a worktree, fail-fast on missing project state) are deferred to issue #03b. This issue assumes inputs are valid; #03b is what makes the system robust to the unhappy paths.

Per ADR-0001 / 0002 / 0005, the mesh is the sole runtime; the Habitat materialises once at launch; the Foreman is per-issue ephemeral.

### Launcher (runtime mode, minimal)

- `npm run mesh -- --project <path> --feature <slug>` (no `--init` flag, that's #08).
- Assumes `feature/<slug>` already exists on the project and `.scratch/<slug>/issues/` is non-empty (validation deferred to #03b — let it crash naturally if absent in this slice).
- `git worktree add`s `feature/<slug>` at `<project>/.mesh-features/<slug>/kanban/` if not already present, and spawns the Kanban from that worktree.
- Never commits to `main`; never `git push`es; never calls a hosted-Git API.

### Kanban (non-LLM long-lived peer)

- Binds a bus socket via the existing `agent-bus` extension; uses the same socket-naming convention as `human-relay`.
- On wake (V1: a polling timer; #05 replaces this with `issue-watcher`), scans `.scratch/<slug>/issues/*.md` and runs a pure-function spawn-decision: `(issueTreeState, currentForemen, maxConcurrent) → spawnDecisions[]`. V1 max-concurrent is hardcoded; #06 wires the flag.
- Never runs a model. Spawns Foremen via the existing `scripts/run-agent.mjs` with `--issue <slug>/<NN>-<slug>` and `--mesh-branch feature/<slug>` flags.
- Logs each dispatch and each Foreman exit (story #26).
- Idles on the bus socket when no work is ready (story #17).

### Per-issue Worktree manager (extension, happy-path only)

- Pure-function core: `prepareWorktree(issuePath, projectPath, meshBranch) → {worktreePath, branchName, mode}`, `disposeWorktree(worktreePath)`, `reintegrate(worktreePath, mode, meshBranch) → {mergedCommit?: sha} | {}`.
- Branch naming: `feature/<feature-slug>-<NN>-<slug>` off `feature/<feature-slug>`.
- `mode` is `"auto-merge"` for `ready-for-agent` and `"branch-emit"` for `ready-for-human` (the latter is exercised by #04, but the manager already supports both modes here so #04 doesn't need to extend it).
- AFK reintegration runs `git merge --ff-only` (or a merge commit) into the mesh branch from the kanban worktree, **not** from the per-issue worktree.
- Tested against a real tmpdir git repo (no model). **Abort-cleanup tests live in #03b.**

### Foreman recipe (`pi-sandbox/agents/ralph/foreman.yaml`, happy-path only)

- `LEAD_HARE_MODEL` tier (story #25).
- Tools palette: `bash, read, write, edit, grep, find, glob, delegate`.
- Habitat overlay declares `submitTo: human-relay` (used only by the HITL path in #04 — AFK runs ignore the field).
- Workflow per claim (happy path):
  1. Read the issue file's `Status:` line; AFK trunk handles `ready-for-agent` only (HITL `ready-for-human` exits early in this issue and is wired up in #04).
  2. Write a `Claimed-by:` line into the issue file.
  3. Call `prepareWorktree` to get a per-issue worktree on `feature/<slug>-<NN>-<slug>`.
  4. Run the Ralph Loop (TDD): write tests, run them, fix failures, commit. Tests run via `bash` inside the per-issue worktree.
  5. On all-tests-pass: call `reintegrate` (auto-merge into `feature/<slug>` with test status in the merge commit message, story #12 AFK half), then close the issue (`git mv` to `issues/closed/`, `Status: closed`, append closing note under `## Comments` — all committed on `feature/<slug>`), then `disposeWorktree`.
- **Abort path (test-fail, kill, timeout) is deferred to #03b.** In this slice, an abort leaks the worktree and per-issue branch — that's #03b's job to clean up.
- Generous default timeout (10–30 min, story #16).

### Acceptance: live-model demo

This is the trunk's HITL gate. Once the hermetic pieces are green, run a tmux integration session per the pattern in `docs/agents.md`, against a small fixture project repo, with a fixture issue produced by the thin Orchestrator (#02). The reviewer watches the merge land on `feature/<slug>` and the issue file move to `issues/closed/`.

## Acceptance criteria

- [ ] Launcher materialises `<project>/.mesh-features/<slug>/kanban/` (creates the worktree if missing) and spawns the Kanban from there.
- [ ] Kanban binds a bus socket and idles when no `ready-for-agent` issues exist.
- [ ] Kanban dispatches one Foreman per `ready-for-agent` issue (V1 hardcoded max concurrency; #06 makes it a flag).
- [ ] Foreman writes a `Claimed-by:` line atomically before doing other work.
- [ ] Foreman creates a per-issue worktree on the right branch and runs project tests inside it via `bash`.
- [ ] On test-pass, Foreman commits its work, AFK auto-merges into `feature/<slug>` with test-status in the commit message, and closes the issue (`git mv` to `issues/closed/` with `Status: closed` + closing note).
- [ ] Per-issue worktree manager has hermetic unit tests against a tmpdir git repo covering: branch naming, off-the-right-base creation, AFK auto-merge, disposal. (Abort-cleanup tests in #03b.)
- [ ] Kanban spawn-decision pure function has unit tests covering: ready issue selected, claimed issue skipped. (Blocked-skipped + non-existent-depends-on lives in #07; full input-shape coverage in #03b.)
- [ ] Mesh issues no `git push` and makes no hosted-Git API calls anywhere in this slice.
- [ ] Live-model tmux integration session: thin Orchestrator drops a `ready-for-agent` issue, mesh dispatches a Foreman, Ralph Loop completes, merge lands on `feature/<slug>`, issue moves to `issues/closed/`. Reviewer signs off.

## Blocked by

- #01 — directory reorg + CONTEXT.md vocabulary
- #02 — thin Orchestrator (provides the QA fixture path without hand-authoring markdown)

## Comments

> *This was generated by AI during triage.*

Slimmed to the happy-path tracer bullet during triage (originally one issue covering happy path + abort cleanup + launcher hardening). The deferred AC items moved to a new sibling issue #03b — see `.scratch/v1-ralph-loop-mesh/issues/03b-afk-trunk-failure-paths.md`. #03b is `ready-for-agent` and `Depends-on: 03-afk-trunk-end-to-end.md`, so it dispatches automatically once this issue's PR merges.
