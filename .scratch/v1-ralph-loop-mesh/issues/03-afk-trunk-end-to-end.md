Status: ready-for-human

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

> *This was generated by AI during triage.*

## Agent Brief

**Category:** enhancement
**Summary:** First end-to-end AFK Ralph-Loop slice: launcher (runtime mode) + Kanban (non-LLM long-lived peer) + per-issue Worktree manager + Foreman recipe + issue-close step. The single tracer-bullet that proves the whole AFK path lands.

**Why ready-for-human:**
Acceptance includes a live-model tmux integration session that requires reviewer sign-off on the merge landing on `feature/<slug>` and the issue moving to `issues/closed/`. This is the trunk's HITL gate, so the slice ships as a PR rather than auto-merging.

**Current behavior:**
The mesh runtime layer exists for the deferred-* stack (atomic-delegate, agent-bus, supervisor, habitat, human-relay) but there is no Kanban-style issue-driven dispatch, no per-issue worktree manager, no Foreman recipe, and no issue-close step. The `npm run mesh` invocation today launches a generic mesh from a topology YAML, not a per-feature, issue-driven Kanban runtime.

**Desired behavior:**
`npm run mesh -- --project <path> --feature <slug>` (no `--init` flag) verifies it is being invoked from inside a worktree of `<project>`, fails fast if `feature/<slug>` or `.scratch/<slug>/issues/` is missing, otherwise creates/fast-forwards `feature/<slug>` off `main`, materialises `<project>/.mesh-features/<slug>/kanban/` as a worktree, and spawns the Kanban from there. The Kanban (no model) binds a bus socket, scans the issue tree, and dispatches one Foreman per `ready-for-agent` issue (with a hardcoded max-concurrency placeholder, wired to a flag in #06). Each Foreman claims its issue, opens a per-issue worktree on `feature/<slug>-<NN>-<slug>` off the mesh branch, runs a TDD Ralph Loop via `bash`, on test-pass auto-merges into `feature/<slug>` from the kanban worktree, closes the issue (`git mv` to `issues/closed/`, set `Status: closed`, append closing note), and disposes its worktree. On test-fail or abort it releases its claim, deletes the per-issue branch ref, disposes the worktree, and exits non-zero.

**Key interfaces:**
- Per-issue Worktree manager (pure-function core, testable against tmpdir git repo): `prepareWorktree(issuePath, projectPath, meshBranch) → {worktreePath, branchName, mode}`, `disposeWorktree(worktreePath)`, `reintegrate(worktreePath, mode, meshBranch) → {mergedCommit?: sha} | {}`. `mode` is `"auto-merge"` or `"branch-emit"` (the latter is only exercised in #04 but the manager supports both shapes here).
- Kanban spawn-decision pure function: `(issueTreeState, currentForemen, maxConcurrent) → spawnDecisions[]`. Hermetic unit tests cover ready/claimed/blocked input shapes (the Depends-on: logic itself wires in #07 — this issue just accepts the input shape).
- Foreman recipe (`pi-sandbox/agents/ralph/foreman.yaml`): `LEAD_HARE_MODEL` tier, tools `bash, read, write, edit, grep, find, glob, delegate`, Habitat overlay `submitTo: human-relay` (used only by HITL in #04).
- Foreman CLI flags from the Kanban: `--issue <feature-slug>/<NN>-<slug>`, `--mesh-branch feature/<feature-slug>`.
- Issue-tracker format per `docs/agents/issue-tracker.md` (Status:, Claimed-by:, Depends-on: lines).

**Acceptance criteria:**
See the issue body's Acceptance criteria section, including the live-model tmux integration sign-off.

**Out of scope:**
- HITL trunk path (#04 — the Foreman recipe needs to handle `Status: ready-for-human` in some form, but the branch-emit submission envelope, supervisor-inbox branch payload, and human-relay surfacing are #04's job).
- Wake-on-change (#05 — V1 here is a polling-tick placeholder).
- `--max-concurrent-foremen` flag (#06 — value is hardcoded here).
- Depends-on: filtering (#07 — spawn-decision accepts the input shape but does not yet honour it).
- `--init` mode and full Orchestrator (#08).
- Mesh cleanup script (#09).
- Any `git push`, hosted-Git API call, or commit on `main`.
