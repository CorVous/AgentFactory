# PRD-0001: Ralph-Loop mesh for AgentFactory V1

> Authored using the `to-prd` skill template. Anchors: [CONTEXT.md](../../CONTEXT.md), [ADR-0001](../../docs/adr/0001-mesh-subsumes-delegation.md), [ADR-0002](../../docs/adr/0002-habitat-materialises-once.md), [ADR-0003](../../docs/adr/0003-supervisor-llm-in-review-loop.md), [ADR-0004](../../docs/adr/0004-drop-llm-reviewer-for-v1.md), [ADR-0005](../../docs/adr/0005-kanban-foreman-worker.md).

## Problem Statement

A developer working in a project repository wants to delegate well-scoped issues to autonomous agents that can write code, run tests, and submit reviewable branches — without micromanaging each step. Today AgentFactory ships a deferred-* mutation stack with end-of-turn approval rails, which is tuned for review-bounded drafting agents and works well for that, but cannot run tests, cannot iterate via TDD, and cannot produce branch-shaped deliverables. Pocock-style "Ralph Loop" workflows (write a test, run it, fix, repeat, commit) cannot be expressed.

The developer also wants the system to *pause* cleanly when there is no work — overnight, between PRDs, when all issues are blocked — without burning model tokens on idle polling.

## Solution

Add a markdown-issue-driven mesh that runs alongside the existing stack, on the same protocol layer. A long-lived **Kanban** peer (non-LLM, like `human-relay.mjs`) watches the **Project**'s issue tree under `.scratch/<feature-slug>/issues/` (file convention defined by this PRD; see the Schema Decisions section) via an `issue-watcher` extension. When an issue becomes ready (`Status: ready-for-agent` or `Status: ready-for-human`), the **Kanban** spawns a **Foreman** (LLM, per-issue, ephemeral) that runs the **Ralph Loop** autonomously: claims the issue file (writes a `Claimed-by:` line), checks out a git worktree on a feature branch, writes tests, runs them, fixes failures, commits. Reintegration takes one of two mesh-internal paths chosen from the issue's `Status:` value at claim time: **AFK** (`ready-for-agent`) auto-merges the feature branch into the workflow branch and closes the issue; **HITL** (`ready-for-human`) emits a submission carrying the branch name to `human-relay` and exits — disposing the worktree releases the branch ref into the project's `.git/`, and the human QAs from the project root with `git checkout feature/...`, runs tests, reads the diff, then merges manually and signals close via `respond_to_request approve`. The branch lives entirely in the Project's local repo; the mesh issues no `git push`, no remote API calls, no hosted-Git interactions. The Foreman can `delegate` to **Workers** (specialist recipes — code review, type-check, etc.) mid-loop for ad-hoc help. When no ready issue files remain, the **Kanban** idles on its bus socket; no Foremen run; no model cost is incurred. The existing deferred-* stack is preserved in named subdirectories — both stacks ride the same bus protocol and **Habitat** materialiser.

## User Stories

(All actors are the developer driving AgentFactory unless otherwise noted.)

1. As a developer, I want to launch the Ralph-Loop mesh against my project (`npm run mesh -- --project ~/Projects/myapp`), so that the mesh starts watching that project's issue state and is ready to take work.
2. As a developer, I want the mesh launch to fail loudly if the project has no `.scratch/` directory with at least one feature slug, so that I do not launch a mesh against an unconfigured project.
3. As a developer, I want to create an issue file under `.scratch/<feature-slug>/issues/` with clear acceptance criteria, so that an autonomous **Foreman** can pick it up and execute it.
4. As a developer, I want the **Kanban** to detect a newly-ready issue file automatically, so that I do not have to signal the mesh manually.
5. As a developer, I want the **Kanban** to spawn one **Foreman** per ready issue, so that issues are worked in parallel up to a concurrency cap.
6. As a developer, I want a configurable concurrency cap (`--max-concurrent-foremen`), so that an unexpected flood of ready issues does not melt my machine or budget.
7. As a developer, I want a **Foreman** to claim its issue file at startup (writing a `Claimed-by:` line), so that the issue's status reflects in-progress work and other Foremen do not also pick it up.
8. As a developer, I want a **Foreman** to create a git worktree on a feature branch named after the issue (e.g., `feature/<feature-slug>-<NN>-<slug>`), so that the Foreman's work is isolated from canonical and visible to me by branch name.
9. As a developer, I want a **Foreman** to run the project's tests inside its worktree, so that the Foreman can self-verify its work before submitting.
10. As a developer, I want a **Foreman** to commit its work to the feature branch in coherent commits, so that the diff and commit history are reviewable through normal git tooling.
11. As a developer, I want a **Foreman** to choose its reintegration path from the issue's `Status:` line at claim time (`ready-for-agent` → auto-merge; `ready-for-human` → push + branch-emit), so that AFK and HITL issues each follow the right mesh-internal workflow.
11a. As a developer, when a **Foreman** completes work on a `ready-for-agent` (AFK) issue with passing tests, I want it to auto-merge its feature branch into the workflow branch and exit cleanly, so that AFK work flows back without human review.
11b. As a developer, when a **Foreman** completes work on a `ready-for-human` (HITL) issue, I want it to emit a submission to `human-relay` carrying the branch name, project path, and test output, then exit (releasing the worktree so the branch becomes freely checkable from the project root), so that I can `git checkout feature/...` locally and QA the branch using whatever tooling I prefer.
11c. As a developer, when a **Foreman**'s tests fail on any issue (AFK or HITL), I want it to abort without merging, so that broken work never pollutes the workflow branch.
11d. As a developer, after I've manually merged a HITL feature branch into the workflow branch, I want to signal `human-relay`'s `respond_to_request approve` action to close the issue (move file to `issues/closed/`, set `Status: closed`, append a closing note); for AFK, the same close happens automatically right after auto-merge succeeds.
12. As a developer, I want the **Foreman** to include test status (pass / fail / not-run) in its `human-relay` submission (HITL path) and in the auto-merge commit message (AFK path), so that the verification record is captured either way.
13. As a developer, for HITL issues, I want the submission to `human-relay` plus the locally-checked-out branch to be the entire QA surface (no PRs, no remote push, no hosted-Git dependency), so that the mesh works against any project regardless of whether it has a remote configured at all.
14. As a developer, for HITL issues, I want `human-relay`'s `revise` action to send feedback to the **Foreman** that produced the submission (or, if the Foreman has already exited, to leave a note in the issue file's `## Comments` section and re-claim), so that revision is a real round-trip and not just rejection.
15. As a developer, I want a rejected or aborted **Foreman** (test failure, HITL `revise`, HITL `reject`) to release its claim (remove the `Claimed-by:` line) and delete its local feature branch ref (`git branch -D feature/...` after the worktree is disposed), so that the issue can be re-attempted and the project's `.git/` does not accumulate stale branch refs from work that did not land. The mesh does **not** delete the branch on `approve` — once the human has merged, the branch ref is a normal merged-feature-branch like any other in the repo, and cleanup is the human's responsibility (`git branch -d` after merge).
16. As a developer, I want **Foreman** timeouts to be generous (10-30 min default), so that a long TDD loop can finish without being killed.
17. As a developer, I want the mesh to pause when no issues are ready, so that I do not pay model cost during inactivity.
18. As a developer, I want the mesh to wake automatically when a new issue becomes ready or a blocker is cleared, so that I do not have to restart anything when I add work.
19. As a developer, I want a blocked issue (one whose file declares dependencies on another open issue) to be invisible to the **Kanban**, so that no **Foreman** is spawned for work that depends on something incomplete.
20. As a developer, I want a **Foreman** to delegate to a **Worker** for code review mid-loop, so that the Foreman can get specialist feedback without reimplementing review logic.
21. As a developer, I want a **Foreman** to delegate to a **Worker** for type-check or other specialist tasks, so that future Worker recipes (a `type-checker`, a `doc-writer`, etc.) compose into Foreman loops without per-Foreman changes.
22. As a developer, I want my existing deferred-stack recipes (`deferred-writer`, `deferred-author`, `writer-foreman`, etc.) to keep working, so that I do not lose drafting agents while V1 ships.
23. As a developer, I want the deferred-stack and the Ralph-Loop stack to live in clearly-labelled subdirectories, so that I can tell which workflow a recipe targets at a glance.
24. As a developer, I want both stacks to share the same bus protocol, **Habitat** materialiser, and `human-relay`, so that future changes to those layers benefit both stacks.
25. As a developer, I want each **Foreman** to spawn with a tier appropriate to its role (probably `LEAD_HARE_MODEL`), so that cost and capability are tuned for the **Ralph Loop**.
26. As a developer, I want clear logging from the **Kanban** about which issues it has dispatched and which **Foremen** are alive, so that I can debug or observe the mesh.
27. As a developer, I want the **Kanban** to clean up worktrees after a **Foreman** exits or times out, so that scratch space does not leak.
28. As a developer, I want the supervisor extension to stay loaded but inert in V1 (per ADR-0004), so that the V2 path to LLM-in-the-loop review is preserved.
29. As a developer, I want the issue-watcher extension to fire on the issue-state changes I care about (issue ready, issue blocked, issue closed), so that the **Kanban** reacts to real events rather than polling on a fixed cadence.
30. As a developer, I want a clear vocabulary (**Kanban**, **Foreman**, **Worker**, **Ralph Loop**, **Project**) in `CONTEXT.md`, so that future architecture conversations do not re-litigate the naming.
31. As a developer, I want ADR-0001 / 0002 / 0003 / 0004 / 0005 referenced from the V1 PRD and from each new module, so that the design rationale is traceable from the code.
32. As a planning agent (e.g., Pocock's `/prd-to-issues`), I want to create thin-vertical-slice issue files that one **Ralph Loop** can complete, so that workforce scales by issue granularity rather than worker complexity.
33. As a developer, I want a future remote-integration module (V2, optional) to extend the V1 HITL path for projects that have a remote configured — adding a `git push` after the Foreman commits, optionally opening a PR via the hosted-Git API, watching it for review-requested events, comments, and CI failures, and feeding those back to a re-spawned Foreman — so that cross-machine review and hosted-Git workflows can opt in without being baked into the V1 mesh.

## Implementation Decisions

### New deep modules

- **Kanban (control plane).** A non-LLM long-lived peer that binds a bus socket, receives `wake` envelopes from the issue-watcher, scans `.scratch/<feature-slug>/issues/*.md`, and spawns Foremen for ready issues. Does not run a model. Bus precedent: the existing `human-relay` peer. Interface: receives bus envelopes; spawns child processes via the existing run-agent script. Owns the spawn-decision logic (which issues to dispatch, which already have a Foreman alive).

- **issue-watcher (extension).** Observes the **Project**'s issue files and emits `wake` envelopes when a relevant transition is observed. Interface: "fire wake envelope to a configured target peer when a relevant issue-state transition happens." V1 ships bare-wake-up semantics (the Kanban re-scans the issue tree on every wake); the envelope-payload schema leaves room for issue-tagged or typed-event variants in V2.

- **Worktree manager (extension).** Owns the per-issue git worktree lifecycle for a Foreman: `git worktree add` (off the workflow branch) on Foreman start, `git worktree remove` on completion or abort. Owns the branch naming convention and the AFK reintegration step (local `git merge` into the workflow branch). For HITL the manager only disposes the worktree — the branch ref persists in the project's `.git/` and the human checks it out from the project root. No `git push`, no hosted-Git API calls. Pure-function core (decide branch name, decide path, decide reintegration mode) testable without a real repo.

- **Reintegration mode selection (Foreman logic).** At claim time, the Foreman reads the issue's `Status:` line: `ready-for-agent` selects auto-merge (local merge into workflow branch, no submission envelope); `ready-for-human` selects emit-submission-then-exit (no merge, no push — disposing the worktree releases the branch ref for the human). Test failure in either mode aborts before reintegration.

- **Foreman recipes.** New YAML recipes under `pi-sandbox/agents/ralph/`. Tools palette includes `bash`, `read`, `write`, `edit`, `grep`, `find`, `glob`, `delegate`. Habitat-overlay fields declare specialist Workers (`agents:`); `submitTo: human-relay` is set unconditionally (used only on the HITL path; AFK runs ignore the field).

- **Submission payload (V1 branch variant, HITL only).** The `submission` bus envelope's payload schema gains a branch-mode variant carrying `branchRef` (e.g., `feature/v1-ralph-loop-mesh-01-kanban-script`), `projectPath`, `issuePath` (relative to the project root, e.g. `.scratch/v1-ralph-loop-mesh/issues/01-kanban-script.md`), optional `testOutput`. No `remoteName`, no `prRef` — V1's HITL is local-only; the human runs `git checkout <branchRef>` from the project root to access it. Only the HITL path emits this envelope. The supervisor inbound rail (`_lib/supervisor-inbox.ts`) handles it via the same action graph; in V1 only `human-relay` invokes those actions (per ADR-0004).

- **Issue-close step.** Two triggers, one helper. (1) AFK: the Foreman, on successful auto-merge, `git mv`s the issue file from `issues/<NN>-<slug>.md` to `issues/closed/<NN>-<slug>.md`, sets `Status: closed`, and appends a closing note under `## Comments`. (2) HITL: the human merges the feature branch manually first (e.g., `git checkout <workflow-branch> && git merge feature/...`), then signals close via `human-relay`'s `respond_to_request approve`; the supervisor inbound rail performs the same `git mv` + edits on the workflow branch. The "merge first, then approve" order is intentional — an open issue is more recoverable than a closed-but-unmerged one if the human forgets a step. The local feature branch ref is **not** deleted on approve (Story #15) — the mesh's branch-cleanup blast radius is bounded to the abort/reject case.

### Modules that move (preserved, not modified)

- The deferred-* stack (`deferred-write`, `deferred-edit`, `deferred-move`, `deferred-delete`, `deferred-confirm`, `sandbox`, `no-edit`, `atomic-delegate`) moves to `pi-sandbox/.pi/extensions/deferred/`. The original deepening conversation (path-validation, sha-verify, scratch-root resolution) becomes scoped to this stack only.
- Recipes that depend on the deferred-* stack (`deferred-writer`, `deferred-author`, `deferred-editor`, `writer-foreman`, `delegator`, `peer-chatter`, `mesh-*`) move to `pi-sandbox/agents/deferred/`.

### Modules that survive at top level (universal)

- `_lib/bus-envelope.ts`, `_lib/bus-transport.ts`, `_lib/habitat.ts`, `_lib/supervisor-inbox.ts`, `_lib/escalation.ts`, `_lib/topology.*`, `_lib/agent-naming.ts`.
- Extensions: `agent-bus`, `habitat`, `supervisor`, `agent-header`, `agent-footer`, `hide-extensions-list`, `no-startup-help`.
- Scripts: `run-agent.mjs`, `launch-mesh.mjs`, `human-relay.mjs`, `agent-naming.mjs`, `breed-names.json`.

### Architectural decisions

- **Kanban is non-LLM.** Dispatch is deterministic; no model in the control plane.
- **Foreman is per-issue ephemeral.** One issue file, one Foreman process. Coordinator (Kanban) persists; Foremen do not.
- **Atomic Delegate survives unchanged for Foreman → Worker.** The same `delegate` tool the deferred stack uses handles mid-loop specialist help in the Ralph stack.
- **Reintegration is path-specific and remote-free.** AFK (`ready-for-agent`) auto-merges the feature branch into the workflow branch — the V1 deliverable for AFK is the merged commit on the workflow branch. HITL (`ready-for-human`) emits a submission to `human-relay` and disposes the worktree — the V1 deliverable for HITL is the local branch ref in the project's `.git/` plus the bus submission. The mesh issues no `git push` and no hosted-Git API calls in V1. Cross-machine review and hosted-Git PRs layer on as opt-in V2 enhancements (Story #33).
- **Project is configured per-mesh-launch.** AgentFactory is a runner. Multi-project meshes are V2.
- **Workers are Atomic Delegate targets only.** They do not read or write the issue tree. Decomposition belongs upstream in PRD-driven planning, not in workers.
- **Pause is genuinely free.** No idle model calls; the Kanban awaits on a bus socket.

### Schema decisions

- The issue-file format (per `docs/agents/issue-tracker.md`) is the schema; V1 reads the `Status:` line, an optional `Claimed-by:` line, and an optional `Depends-on:` line. The lifecycle (ready → claimed → closed) is encoded by edits to those lines.
- The Submission envelope payload schema gains a branch-mode variant; existing artifact-list payload remains for the deferred stack.
- The `wake` envelope from issue-watcher to Kanban is bare-wake-up in V1: just a notification to re-scan the issue tree. Issue-tagged and typed-event variants are deferred.

### Contract decisions

- The Foreman receives its issue path via a CLI flag (`--issue <feature-slug>/<NN>-<slug>`, resolved against the project's `.scratch/`) when spawned by the Kanban. Same flag-passing mechanism the runner uses today for `--habitat-spec`.
- The Foreman receives its workflow branch via a CLI flag (`--workflow-branch <ref>`, default `main`) so the worktree branches off the right base and AFK reintegration knows where to merge.
- The Foreman's `submitTo` is `human-relay` in V1, used only on the HITL path. AFK runs do not emit a submission envelope.
- The Worktree manager exposes `prepareWorktree(issuePath, projectPath, workflowBranch) → {worktreePath, branchName, mode}` (where `mode` is `"auto-merge"` or `"branch-emit"`) and `disposeWorktree(worktreePath)` to the Foreman, called at session start and end respectively. The reintegration call is a separate method on the same module: `reintegrate(worktreePath, mode) → {mergedCommit?: sha} | {} `. AFK returns the workflow-branch commit sha after a local `git merge --ff-only` (or merge commit). HITL returns an empty object — disposeWorktree is sufficient to release the branch ref for the human. No `git push` and no hosted-Git API calls.

## Testing Decisions

A good test exercises the *external behaviour* of a deep module with real inputs and asserts on observable outputs — no mocking of internal collaborators, no asserting on private state. The hermetic-by-contract rule from `docs/agents.md` (no live model, no real network, no FS outside tmpdir) applies; integration tests that need a live model stay in the tmux pattern, not in `npm test`.

### Modules that should have unit tests

- **issue-watcher's transition detection.** Pure function over two snapshots of issue-tree state: emits the right wake events for each transition. Trivially testable without a real `.scratch/` tree — feed it fixture snapshots (parsed issue-file metadata).
- **Worktree manager's lifecycle.** Given a project path and an issue ID: does it create a worktree on the right branch and clean up correctly on success and on abort? Testable against a tmpdir git repo (real git, no model).
- **Submission payload schema (branch variant).** Given a branch-mode payload, does the bus envelope schema accept it; does an invalid one get rejected? Unit test on the schema, mirroring `_lib/bus-envelope.test.ts`.
- **Kanban's spawn decision.** Pure function from `(issueTreeState, currentForemen, maxConcurrent) → spawnDecisions[]`. Testable with fake issue-tree fixtures.
- **`_lib/supervisor-inbox.ts` action graph for branch payloads.** Existing tests cover artifact-list payloads; add the branch-mode payload variant. Same action graph, new payload shape.

### Prior art

- `_lib/habitat.test.ts` — testing a deep materialisation module against a fake spec.
- `_lib/supervisor-inbox.test.ts` — testing an action graph in isolation from a live model.
- `_lib/bus-envelope.test.ts` — testing wire-format schemas.
- `_lib/atomic-delegate.test.ts` — testing a control-flow module with fake transport.
- `docs/agents.md`'s tmux integration pattern — for end-to-end Foreman behaviour with a real model. Use sparingly for V1 acceptance; not in CI.

### Modules with reduced test scope

- `scripts/kanban.mjs` itself: thin shell over the spawn-decision pure function and the bus transport. Test the pure function; manual-verify the shell.
- Foreman recipes: behavioural tests are the integration-tmux pattern, not unit. Hermetic V1 test target is "the Foreman recipe loads under `npm run agent --` without erroring," which is mostly free.
- The filesystem itself is not under test; treat it as an external system. The issue-watcher's *parsing* of issue-file metadata is, however, under test.

## Out of Scope

- **Remote pushing and hosted-Git integration.** V1's HITL path is local-only: the Foreman commits to a feature branch in the project's `.git/`, emits its name to `human-relay`, and exits. No `git push`, no hosted-Git API calls (no `gh pr create`, no GitLab API). A future opt-in module that adds `git push` after the Foreman commits, opens PRs via the hosted-Git API, watches for review-requested events, comments, and CI failures, and feeds them back to a re-spawned Foreman is V2 (see Story #33). V1 ships the local-only baseline that works in any project — even one with no remote configured.
- **LLM reviewer in the loop.** Per ADR-0004, the supervisor LLM is not in V1. ADR-0003 is preserved as future-state.
- **Issue-tree decomposition.** Foremen do not create child issue files for sub-tasks. Decomposition is a planning step (`/prd-to-issues`-style), upstream of the mesh.
- **Multi-project meshes.** Each `npm run mesh` invocation binds to one **Project**. A registry of projects with per-issue project routing is V2.
- **Persistent / warm Foremen.** Foremen are ephemeral per-issue. Long-lived Foremen that hold context across issues are not V1.
- **Custom Worker registration from external recipes.** V1 Workers come from in-tree recipes. A public registration API for external Worker plugins is not V1.
- **A typed-event bus protocol for issue-state transitions.** V1 ships with bare-wake-up envelopes; richer event variants are deferred.
- **Replacing or removing the deferred-* stack.** It stays. Only directory layout changes.
- **Podman / OS-level containment around Foremen.** V1 Ralph workers run with bash and trust pi's `cwd` plus the worktree boundary. Containerised Foremen are a separate future axis.
- **The deferred-* deepening (Stage-validate-apply unification).** That work was the original wedge that surfaced this redesign. It still has merit *scoped to the deferred-* stack only*; a separate issue can carry it after V1 ships.

## Further Notes

- The construction-site vocabulary (**Kanban** / **Foreman** / **Worker**) is recorded in `CONTEXT.md` alongside the existing **Recipe** / **Role** / **Peer** / **Tier** / **Habitat** domain. Old uses of "worker" (e.g., in ADR-0001) refer to the **Atomic Delegate** child sense and are flagged as legacy in the Flagged ambiguities section.
- The user stories above are intentionally thin-vertical-slice. Each is meant to be `/prd-to-issues`-able into a single issue file that one **Ralph Loop** can complete. The ordering reflects dependency intuition: #1-#19 are the spine; #20-#21 are mid-loop delegation; #22-#24 are stack coexistence; #25-#29 are operational; #30-#33 are documentation and forward-compatibility.
- Pocock's `to-prd` skill template was used as the structural reference for this PRD. The template's "publish to issue tracker" step is adapted to this repo's local-markdown convention (see `docs/agents/issue-tracker.md`): the PRD is committed alongside its issues at `.scratch/v1-ralph-loop-mesh/PRD.md`, and the `/prd-to-issues` step (when run) would create issue files at `.scratch/v1-ralph-loop-mesh/issues/<NN>-<slug>.md` rather than GH issues.
- Future architecture-review conversations should not re-litigate ADR-0001 / 0002 / 0003 / 0004 / 0005 without proposing a superseding ADR.
