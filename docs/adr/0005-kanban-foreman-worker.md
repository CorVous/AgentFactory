# Kanban dispatches Foremen who arrange Workers for their kanban story

V1 of AgentFactory adds a bd-issue-driven mesh on top of the existing protocol layer. A long-lived non-LLM **Kanban** peer watches the **Project**'s bd state via a `bd-watcher` extension; on each ready issue it spawns an LLM **Foreman** running the **Ralph Loop**. Foremen `delegate` mid-loop to **Workers** (specialist **Recipes**) for ad-hoc help. Submissions are git branches; in V1 they route to `human-relay` for QA (per [ADR-0004](./0004-drop-llm-reviewer-for-v1.md)). The existing deferred-* + **Atomic Delegate** stack is preserved in subdirectories — both stacks coexist on the same protocol layer for different workflows.

## Why

- **Beads is already the project's source of truth for issues.** Re-implementing a kanban as an in-memory peer would fight bd's existing semantics (`bd ready`, `bd update --claim`'s atomicity, `--depends-on` chains). Layering on bd is cheaper and inherits bd's tooling for free.
- **Foremen need to run tests before submitting.** This was the wedge that started the architecture review. Today's `sandbox.ts` blocks `bash` outright, so peers cannot run tests in their **Scratch Sandbox**. A Foreman with bash, an isolated git worktree, and a generous timeout *can*. Branch-as-**Submission** falls out of the worktree shape.
- **Pause-when-blocked should cost zero.** A long-lived LLM-driven dispatcher polling bd burns model tokens overnight for no work. A non-LLM Kanban (`scripts/kanban.mjs`) idles on a bus socket; pause is genuinely free. Foremen spawn only when an issue actually needs work.
- **Construction-site vocabulary names roles cleanly.** **Kanban** (the board), **Foreman** (per-job manager), **Workers** (specialist labour) maps onto the bd-driven shape without re-using existing overloaded terms. The `CONTEXT.md` update names this disambiguation.
- **Existing recipes are already-shaped for V1.** `writer-foreman.yaml` is a Foreman in the new vocabulary; `code-reviewer.yaml` and `change-reviewer.yaml` are Workers. The rename ratifies what was already true.

## Considered alternatives

- **Foremen self-poll bd; no Kanban.** Rejected: peers shouldn't *exist* when there is no work — a self-poll model needs a warm pool, which costs model turns even during pause. Atomicity of `bd update --claim` works for races, but the cost shape is wrong.
- **Kanban is itself an LLM-driven peer.** Rejected: dispatch is deterministic. An LLM dispatcher pays per-decision cost for what reduces to "see ready issue, spawn Foreman."
- **Atomic Delegate is the only spawn primitive (a Foreman dispatches Foremen via `delegate`).** Rejected for the *Kanban → Foreman* hop: Atomic Delegate's spawn-and-die assumed an *ephemeral worker doing one thing for the caller*. A Foreman is *issue-bound*, not caller-bound; its lifecycle is a bd-issue lifecycle. Atomic Delegate survives intact for the *Foreman → Worker* hop, where it *is* spawn-and-die.
- **Bd-mediated decomposition (Foremen create child bd issues for sub-tasks).** Rejected for V1: pollutes the kanban with execution-internal sub-tasks; the human-driven `/prd-to-issues` planning step is the right place to decompose. Foremen call **Workers** via Atomic Delegate (mid-loop, opaque to bd) for ad-hoc help.
- **Replace deferred-* stack entirely.** Rejected. The deferred-* + Atomic Delegate stack works for review-bounded drafting agents and is already shipped. V1 *adds* the Ralph-Loop stack; it does not remove anything.

## Consequences

### New components

- `scripts/kanban.mjs` — long-lived non-LLM peer; binds a bus socket; receives `wake` envelopes from the bd-watcher; spawns Foremen for ready bd issues via `node scripts/run-agent.mjs <foreman-recipe> --issue beads-NNN`. Precedent: `scripts/human-relay.mjs`.
- `pi-sandbox/.pi/extensions/ralph/bd-watcher.ts` — runs alongside the Kanban peer; watches bd state changes; emits `wake` bus envelopes to the Kanban. V1 ships with bare-wake-up envelopes (Kanban re-queries bd on every wake).
- `pi-sandbox/.pi/extensions/ralph/worktree-mgr.ts` — owns the `git worktree add` / `git worktree remove` lifecycle for a Foreman's per-issue worktree, plus the branch naming convention (`feature/beads-NNN-<slug>` or similar).
- `pi-sandbox/agents/ralph/<foreman-name>.yaml` — V1 Foreman **Recipes**. Tools palette includes `bash`, `git` (via bash), the project's test command, plus standard fs tools and `delegate`. Habitat-overlay fields declare which **Workers** a Foreman may delegate to (`agents:`) and where its submissions land (`submitTo: human-relay`).

### Layout and migration

- `pi-sandbox/agents/deferred/` — existing deferred-stack recipes (`deferred-writer`, `deferred-author`, `deferred-editor`, `writer-foreman`, `delegator`, `peer-chatter`, `mesh-*`) move here. They keep working unchanged.
- `pi-sandbox/agents/ralph/` — new V1 Foreman + Worker recipes.
- `pi-sandbox/.pi/extensions/deferred/` — `deferred-write`, `deferred-edit`, `deferred-move`, `deferred-delete`, `deferred-confirm`, `sandbox`, `no-edit`, `atomic-delegate` move here. Self-contained sub-stack.
- `pi-sandbox/.pi/extensions/ralph/` — V1 extensions (`bd-watcher`, `worktree-mgr`, possibly `bd-tools`, possibly `test-runner`).
- Top-level (universal, both stacks ride): `agent-bus`, `habitat`, `supervisor`, `agent-header`, `agent-footer`, `hide-extensions-list`, `no-startup-help`, `_lib/*`, `human-relay.mjs`.
- The runner script (`scripts/run-agent.mjs`) and the mesh launcher (`scripts/launch-mesh.mjs`) are stack-agnostic.

### Mesh launch

- `npm run mesh -- --project ~/Projects/myapp` becomes the canonical V1 entry point. **Bus Root**, beads instance, and worktree scratch are all scoped to that **Project**.
- Multi-project (one **Mesh** against multiple **Projects**) is V2; the bd schema would need a project field.

### Submission shape

- The `submission` bus envelope's payload schema gains a branch-mode variant: `branchRef`, `projectPath`, `issueId`, optional `testOutput`. The wire format stays bus-envelope-compatible.
- `_lib/supervisor-inbox.ts`'s action graph handles the new payload via the same approve/reject/revise/escalate surface; in V1 only `human-relay` invokes those actions (per ADR-0004).

### What survives unchanged

- **[ADR-0001](./0001-mesh-subsumes-delegation.md) (mesh subsumes delegation):** bus protocol, envelope format, peer-allowlist, `_lib/bus-transport.ts` — all unchanged. Both stacks ride them.
- **[ADR-0002](./0002-habitat-materialises-once.md) (Habitat materialises once):** `_lib/habitat.ts` and the materialisation rule are unchanged. Foremen and Workers each have a **Habitat** resolved at session start.
- **[ADR-0003](./0003-supervisor-llm-in-review-loop.md) (supervisor LLM in review loop):** preserved as future-state per [ADR-0004](./0004-drop-llm-reviewer-for-v1.md); no V1 changes.

### Trade-offs

- Foreman timeout is generous (target 10–30 min) because a **Ralph Loop** can take many model turns. Workers (Atomic Delegate targets) keep the existing 5-minute default.
- Foreman concurrency: an unbounded Kanban could spawn N Foremen for N ready issues. V1 ships with a `--max-concurrent-foremen` cap; default value is set by the PRD.
- Foremen run with bash. Containment becomes the worktree boundary plus pi's `cwd`; the OS-level FS isolation that `sandbox.ts` provides for the deferred stack does not apply. This is intentional — the trust posture for V1 Ralph is "trust pi to behave; humans review the resulting branch." A future Ralph-with-podman variant is possible without changing this ADR.
