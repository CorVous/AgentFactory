Status: needs-triage

# AFK trunk end-to-end

## Parent

[PRD-0001: Ralph-Loop mesh for AgentFactory V1](../PRD.md)

## What to build

The full AFK Ralph-Loop happy path, demoable end-to-end against a real project: a developer drops a `ready-for-agent` issue (via the thin Orchestrator from #02) and the mesh works it from claim to merge to close without human interaction. This is one tracer-bullet vertical slice that cuts through the launcher, the Kanban control plane, the Foreman recipe, the per-issue worktree manager, and the issue-close step. It is intentionally chunky — every step is required to demonstrate the path, and the next-tier refinements (wake-on-change, concurrency cap, depends-on filter) layer on top in subsequent issues.

Per ADR-0001 / 0002 / 0005, the mesh is the sole runtime; the Habitat materialises once at launch; the Foreman is per-issue ephemeral.

### Launcher (runtime mode)

- `npm run mesh -- --project <path> --feature <slug>` (no `--init` flag, that's #08).
- Refuses to run unless invoked from inside a worktree of `<project>`.
- Fails fast and clearly if `feature/<slug>` does not exist on the project, or if `.scratch/<slug>/issues/` is missing/empty on that branch.
- Otherwise: ensures `feature/<slug>` exists off `main` (creates if absent, fast-forwards if behind), `git worktree add`s it at `<project>/.mesh-features/<slug>/kanban/` if not already present, and spawns the Kanban from that worktree.
- Never commits to `main`; never `git push`es; never calls a hosted-Git API.

### Kanban (non-LLM long-lived peer)

- Binds a bus socket via the existing `agent-bus` extension; uses the same socket-naming convention as `human-relay`.
- On wake (V1: a polling timer; #05 replaces this with `issue-watcher`), scans `.scratch/<slug>/issues/*.md` and runs a pure-function spawn-decision: `(issueTreeState, currentForemen, maxConcurrent) → spawnDecisions[]`. V1 max-concurrent is hardcoded; #06 wires the flag.
- Never runs a model. Spawns Foremen via the existing `scripts/run-agent.mjs` with `--issue <slug>/<NN>-<slug>` and `--mesh-branch feature/<slug>` flags.
- Logs each dispatch and each Foreman exit (story #26).
- Idles on the bus socket when no work is ready (story #17).

### Per-issue Worktree manager (extension)

- Pure-function core: `prepareWorktree(issuePath, projectPath, meshBranch) → {worktreePath, branchName, mode}`, `disposeWorktree(worktreePath)`, `reintegrate(worktreePath, mode, meshBranch) → {mergedCommit?: sha} | {}`.
- Branch naming: `feature/<feature-slug>-<NN>-<slug>` off `feature/<feature-slug>`.
- `mode` is `"auto-merge"` for `ready-for-agent` and `"branch-emit"` for `ready-for-human` (the latter is exercised by #04, but the manager already supports both modes here so #04 doesn't need to extend it).
- AFK reintegration runs `git merge --ff-only` (or a merge commit) into the mesh branch from the kanban worktree, **not** from the per-issue worktree.
- Tested against a real tmpdir git repo (no model).

### Foreman recipe (`pi-sandbox/agents/ralph/foreman.yaml`)

- `LEAD_HARE_MODEL` tier (story #25).
- Tools palette: `bash, read, write, edit, grep, find, glob, delegate`.
- Habitat overlay declares `submitTo: human-relay` (used only by the HITL path in #04 — AFK runs ignore the field).
- Workflow per claim:
  1. Read the issue file's `Status:` line; AFK trunk handles `ready-for-agent` only (HITL `ready-for-human` exits early in this issue and is wired up in #04).
  2. Write a `Claimed-by:` line into the issue file.
  3. Call `prepareWorktree` to get a per-issue worktree on `feature/<slug>-<NN>-<slug>`.
  4. Run the Ralph Loop (TDD): write tests, run them, fix failures, commit. Tests run via `bash` inside the per-issue worktree.
  5. On all-tests-pass: call `reintegrate` (auto-merge into `feature/<slug>` with test status in the merge commit message, story #12 AFK half), then close the issue (`git mv` to `issues/closed/`, `Status: closed`, append closing note under `## Comments` — all committed on `feature/<slug>`), then `disposeWorktree`.
  6. On test-fail or any abort: remove the `Claimed-by:` line, `disposeWorktree`, then `git branch -D feature/<slug>-<NN>-<slug>` so stale refs do not accumulate (story #15). Issue returns to ready.
- Generous default timeout (10–30 min, story #16).

### Acceptance: live-model demo

This is the trunk's HITL gate. Once the hermetic pieces are green, run a tmux integration session per the pattern in `docs/agents.md`, against a small fixture project repo, with a fixture issue produced by the thin Orchestrator (#02). The reviewer watches the merge land on `feature/<slug>` and the issue file move to `issues/closed/`.

## Acceptance criteria

- [ ] Launcher refuses to run outside a worktree (clear error message).
- [ ] Launcher fails fast when `feature/<slug>` or `.scratch/<slug>/issues/` is missing on the project.
- [ ] Launcher creates / fast-forwards `feature/<slug>` off `main`, materialises `<project>/.mesh-features/<slug>/kanban/`, spawns the Kanban from there.
- [ ] Kanban binds a bus socket and idles when no `ready-for-agent` issues exist.
- [ ] Kanban dispatches one Foreman per `ready-for-agent` issue (V1 hardcoded max concurrency; #06 makes it a flag).
- [ ] Foreman writes a `Claimed-by:` line atomically before doing other work.
- [ ] Foreman creates a per-issue worktree on the right branch and runs project tests inside it via `bash`.
- [ ] On test-pass, Foreman commits its work, AFK auto-merges into `feature/<slug>` with test-status in the commit message, and closes the issue (`git mv` to `issues/closed/` with `Status: closed` + closing note).
- [ ] On test-fail or abort, Foreman releases its claim, deletes the per-issue branch ref, disposes the worktree, and exits non-zero. The issue is selectable again on the next Kanban scan.
- [ ] Per-issue worktree manager has hermetic unit tests against a tmpdir git repo covering: branch naming, off-the-right-base creation, AFK auto-merge, disposal, abort cleanup.
- [ ] Kanban spawn-decision pure function has unit tests covering: ready issue selected, claimed issue skipped, blocked issue skipped (the depends-on logic itself is wired in #07 but the spawn-decision contract should already accept the input shape).
- [ ] Mesh issues no `git push` and makes no hosted-Git API calls anywhere in this slice.
- [ ] Live-model tmux integration session: thin Orchestrator drops a `ready-for-agent` issue, mesh dispatches a Foreman, Ralph Loop completes, merge lands on `feature/<slug>`, issue moves to `issues/closed/`. Reviewer signs off.

## Blocked by

- #01 — directory reorg + CONTEXT.md vocabulary
- #02 — thin Orchestrator (provides the QA fixture path without hand-authoring markdown)

## Comments
