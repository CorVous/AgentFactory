Status: needs-triage

# HITL trunk end-to-end

## Parent

[PRD-0001: Ralph-Loop mesh for AgentFactory V1](../PRD.md)

## What to build

The full HITL Ralph-Loop happy path, demoable end-to-end against a real project: a developer drops a `ready-for-human` issue (via the thin Orchestrator from #02), the mesh works it up to the point where human QA is needed, hands it off via `human-relay` carrying the per-issue branch ref, and the human's `approve` / `reject` / `revise` actions drive the issue to closure (or back into the loop). One tracer-bullet vertical slice that cuts through the bus-envelope schema, the supervisor-inbox action graph, the Foreman recipe (HITL branch), and the `human-relay` close + revise flows.

V1 stays local-only per ADR-0004 and PRD §Out-of-scope: no `git push`, no hosted-Git API calls. The supervisor LLM stays loaded but inert — only `human-relay` invokes the action graph in V1 (story #28).

### Submission payload (branch-mode variant)

- Extend the bus envelope's `submission` payload schema in `_lib/bus-envelope.ts` (or wherever the schema lives in the post-#01 layout) with a branch-mode variant carrying:
  - `branchRef` — e.g., `feature/v1-ralph-loop-mesh-04-hitl-trunk-end-to-end`
  - `projectPath` — absolute path to the project root checkout
  - `issuePath` — relative to the project root, e.g., `.scratch/v1-ralph-loop-mesh/issues/04-hitl-trunk-end-to-end.md`
  - `testOutput` — optional, captured pass/fail summary
- Existing artifact-list payloads continue to validate — this is an additive variant.
- Pure-schema unit test covering accept/reject of well-formed and malformed payloads.

### Supervisor-inbox handler

- Extend `_lib/supervisor-inbox.ts` action graph to route the branch-mode payload through the same `approve` / `reject` / `revise` actions used today for artifact-list submissions. The supervisor LLM does not invoke these actions in V1; only `human-relay` does (per ADR-0004).
- Action semantics for branch payloads:
  - `approve` — close the issue: `git mv issues/<NN>-<slug>.md issues/closed/<NN>-<slug>.md`, set `Status: closed`, append a closing note under `## Comments`. All committed on `feature/<slug>`. Per PRD §Implementation §Issue-close step, the human is expected to have merged the per-issue branch into `feature/<slug>` themselves *before* sending `approve`. The mesh does **not** delete the per-issue branch ref on approve (story #15).
  - `reject` — append a rejection note under `## Comments` on the issue file (no `git mv`); leave the per-issue branch ref alone for the human to dispose. Issue is no longer claimed.
  - `revise` — send a `revision-requested` envelope to the live Foreman if it is still running; if it has already exited, append the revision note to the issue file's `## Comments` section and re-claim by spawning a fresh Foreman against the same issue (story #14). Cap at 3 revisions per thread (existing behaviour in `_lib/supervisor-inbox.ts`).
- Hermetic unit tests on the action graph cover the branch-payload variant for each action without a live model.

### HITL Foreman path

- The Foreman recipe from #03 already supports `Status: ready-for-human`. This issue wires up the branch-emit half:
  1. Claim the issue (write `Claimed-by:` line) — same as AFK.
  2. Call `prepareWorktree` with `mode: "branch-emit"`.
  3. Run the Ralph Loop: write tests, run them, fix, commit. Identical to AFK except the test-status field is captured for the submission payload (story #12 HITL half).
  4. On all-tests-pass: emit a branch-mode `submission` envelope to `human-relay` carrying `branchRef`, `projectPath`, `issuePath`, `testOutput`. Then `disposeWorktree` and exit. The per-issue branch ref persists in the project's `.git/`; the human checks it out from the project root or a temp worktree.
  5. On test-fail or any abort: same as AFK — release claim, dispose worktree, delete per-issue branch ref, exit non-zero. Story #11c.

### `human-relay` integration

- `human-relay` already implements `respond_to_request approve | reject | revise` against the existing supervisor-inbox action graph. This issue extends `human-relay`'s prompt / TUI to surface the branch-mode submission cleanly: show the `branchRef`, the `projectPath`, a hint that the human should `git checkout <branchRef>` and merge into `feature/<slug>` before sending `approve`, and the `testOutput` summary if present.
- For `revise`, the input note is required and is forwarded to the supervisor-inbox `revise` action.

### Acceptance: live-model demo

This is the trunk's HITL gate. Run a tmux integration session against a small fixture project repo. The thin Orchestrator (#02) drops a `ready-for-human` issue. The mesh dispatches a Foreman; the Foreman runs the Ralph Loop and ships the submission to `human-relay`. The reviewer plays the human role: `git checkout` the branch, merge into `feature/<slug>` from the kanban worktree, then send `approve` via `human-relay`. The reviewer watches the issue move to `issues/closed/` on `feature/<slug>`. A second run exercises `revise`: the reviewer sends a revision note, watches the Foreman pick it up (or re-claim from the comment), and confirms the revision cap at 3 holds.

## Acceptance criteria

- [ ] `submission` envelope schema accepts the new branch-mode variant; pure-schema unit tests pass for well-formed and malformed payloads; existing artifact-list payloads still validate.
- [ ] `_lib/supervisor-inbox.ts` action graph routes branch-mode payloads through `approve` / `reject` / `revise` with the semantics above; hermetic unit tests cover each action without a live model.
- [ ] Foreman emits a branch-mode submission to `human-relay` only on the `ready-for-human` path; AFK runs do not emit a submission envelope.
- [ ] On `approve`, the issue file moves to `issues/closed/` on `feature/<slug>` with `Status: closed` and a closing-note `## Comments` entry. The per-issue branch ref is not deleted (story #15).
- [ ] On `reject`, the issue file gets a rejection-note `## Comments` entry, `Claimed-by:` is removed, and the per-issue branch ref is left intact for the human to dispose.
- [ ] On `revise`, a live Foreman receives the note via the bus; an exited Foreman case appends the note to `## Comments` and a fresh Foreman re-claims the issue. The 3-revision cap holds.
- [ ] No `git push` and no hosted-Git API calls anywhere in this slice. The supervisor LLM is loaded but does not invoke action-graph actions (only `human-relay` does).
- [ ] Live-model tmux integration session: thin Orchestrator drops a `ready-for-human` issue, mesh dispatches, Foreman ships submission, reviewer-as-human merges + sends `approve`, issue closes on `feature/<slug>`. A second run exercises `revise` end-to-end. Reviewer signs off on both.

## Blocked by

- #03 — AFK trunk end-to-end (Foreman recipe, per-issue worktree manager, Kanban dispatch all land there)

## Comments
