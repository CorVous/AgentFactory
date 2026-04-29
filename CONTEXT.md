# AgentFactory

Workspace for building and running multi-agent compositions on top of `@mariozechner/pi-coding-agent`. Agents are pi processes wired together by recipes and topologies; the system enforces containment via rails so each peer's blast radius is explicit and auditable.

## Language

### Identity

**Recipe**:
A YAML file in `pi-sandbox/agents/<name>.yaml` defining a **Role** — prompt, tools, model **Tier**, declared peer relationships.
_Avoid_: agent file, config, template

**Role**:
The reusable identity a **Recipe** defines.
_Avoid_: agent type, kind

**Peer**:
A running pi process bound to a **Bus Root**, addressed by its **Instance Name**. Every peer binds a bus socket at `session_start`, even if its tool palette excludes peer-talk tools (`agent_send`, `agent_call`, etc.). **Kanban**, **Foremen**, and **Workers** (V1 Ralph-Loop **Roles**) are all peers; so are non-pi peers like `human-relay.mjs`.
_Avoid_: agent instance, child

**Instance Name**:
Unique `<breed>-<shortName>` slug per running peer; doubles as bus-socket identity.
_Avoid_: agent name (ambiguous between role and instance), id

**Tier**:
A model class — `RABBIT_SAGE_MODEL` (planner), `LEAD_HARE_MODEL` (overseer), `TASK_RABBIT_MODEL` (worker).

### Containment

**Habitat**:
Per-instance containment perimeter for one **Peer** — scratch FS, peer allowlists, supervisor, submitTo, tools, model — resolved once at session start; **Rails** read from it. Materialised at session_start by the `habitat` baseline extension; rails read fields via `getHabitat()` from `_lib/habitat.ts`.
_Avoid_: sandbox (overloaded), environment, scope, surface

**Scratch Sandbox**:
A peer's compute-only filesystem, wiped between calls, never the source of truth.
_Avoid_: worker sandbox, working directory

**Canonical Sandbox**:
A peer's source-of-truth filesystem; **Submissions** apply here.
_Avoid_: real sandbox, output directory

**Rail**:
An extension that enforces one axis of a **Habitat** — FS containment, write-existence, peer allowlist, supervisor handler, etc.

### Communication

**Bus Root**:
Directory holding peer Unix sockets at `${BUS_ROOT}/${instance_name}.sock`.

**Mesh**:
A running collection of **Peers** sharing one **Bus Root**.

**Submission**:
A typed envelope from a worker to its **submitTo** peer carrying staged artifacts (writes, edits, moves, deletes) for review and atomic apply.

**Bundle**:
Files seeded into a worker's **Scratch Sandbox** by its supervisor at call time, with SHA-256 receipts for drift detection at apply.
_Avoid_: workspace, payload

**Supervisor**:
A peer's escalation target for approvals; chains until it reaches a peer with a UI.

**submitTo**:
A peer's submission target; the peer that receives and applies the worker's artifacts.

### Patterns

**Static Topology**:
Pre-declared mesh shape in a topology YAML; the launcher brings up all peers at startup.

**Seed Agent**:
A user-launched agent that dynamically grows its own mesh by spawning peers; the mesh exists for the seed's session only.

**Atomic Delegate**:
Single-tool 1→1 spawn-call-collect; queues the spawned peer's **Submission** into the caller's deferred-confirm rail; tears the peer down. Survives unchanged in V1 Ralph-Loop architecture as the **Foreman → Worker** primitive.

### Roles (V1 Ralph-Loop architecture)

The deferred-* + **Atomic Delegate** stack defined above remains the model for review-bounded drafting agents. V1 also adds a markdown-issue-driven Ralph-Loop stack with three named roles, riding the same protocol layer (bus, **Habitat**, supervisor inbox).

**Kanban**:
A long-lived non-LLM **Peer** that watches the **Project**'s issue tree (`.scratch/<feature-slug>/issues/*.md`, per `docs/agents/issue-tracker.md`) and dispatches **Foremen** for ready issues. Implemented as a script (no pi runtime, no model calls). Bus precedent: `human-relay.mjs`. Pause-when-blocked is "Kanban idle, no Foremen running."
_Avoid_: dispatcher, scheduler, foreman-script

**Foreman**:
An LLM **Peer** spawned by a **Kanban** for one ready issue file. Runs the **Ralph Loop** autonomously: claims the issue (writes a `Claimed-by:` line into the file), creates a git worktree on a feature branch, writes tests, runs them, fixes failures, commits, submits the branch. Arranges **Workers** for ad-hoc help via **Atomic Delegate**. Existing Recipe in the deferred stack: `writer-foreman.yaml` — same role name, different mutation primitives.
_Avoid_: worker (overloaded — see Flagged ambiguities), agent, planner

**Worker**:
An LLM **Peer** **Atomic-Delegated** by a **Foreman** for a specialist subtask — code review, type-check, doc-write, etc. Ephemeral; no issue-tree interaction. Existing Recipes: `code-reviewer.yaml`, `change-reviewer.yaml`.
_Avoid_: helper, sub-agent; "specialist" only informally

**Ralph Loop**:
The **Foreman**'s per-issue inner-loop pattern (after Matt Pocock): claim issue → worktree → write test → run test → fail → fix → re-run → pass → commit → submit. One pi session per issue, ending when the Foreman submits.
_Avoid_: agent loop, work loop, TDD loop (Ralph Loop is the named one in this codebase)

**Project**:
The canonical repository a **Mesh** is wired to at launch. `npm run mesh -- --project ~/Projects/myapp --feature <slug>` binds the mesh's **Bus Root**, the kanban worktree at `<project>/.mesh-features/<feature-slug>/kanban/`, and per-issue worktree scratch to that `(project, feature)` pair. AgentFactory itself is a *runner*; it is never the **Project**.
_Avoid_: target, repo (in code, but the term is **Project** in design discussions)

**Feature**:
The unit of mesh work — a coherent body of effort the user wants to ship as one integration into `main`. Each feature has a slug (e.g., `v1-ralph-loop-mesh`), a dedicated branch (`feature/<feature-slug>`), a dedicated worktree, a PRD, and a set of vertical-slice issue files. The mesh authoring flow (**Orchestrator**) and runtime (**Kanban** + **Foremen**) are scoped to one feature per invocation.
_Avoid_: project (overloaded), epic, milestone

**Orchestrator**:
A planning-time LLM **Peer** (Lead Hare tier, interactive) that runs *before* the mesh's runtime, from inside the feature's kanban worktree. Drives a grill session, produces `.scratch/<feature-slug>/PRD.md`, then breaks the PRD into vertical-slice issue files via deferred-write for the user to review and commit. Distinct from the **Kanban** (which dispatches at runtime) and from **Foremen** (which execute issues). Existing Recipe (planned): `pi-sandbox/agents/ralph/orchestrator.yaml`.
_Avoid_: planner (too generic), prd-writer, scoper

### Supervisor Actions

When inbound rail surfaces a **Submission** or approval request, the supervisor's LLM picks via `respond_to_request`:

- **Approve** — rail applies artifacts to canonical, replies success.
- **Reject** — rail discards, replies failure.
- **Revise** — rail asks the worker to redo with feedback; thread preserved; worker keeps its in-memory queue.
- **Escalate** — rail forwards to *this* supervisor's own supervisor; relays the result back.

## Relationships

- A **Recipe** defines a **Role**; one role can be instantiated as many **Peers**.
- A **Peer** runs in one **Habitat**, resolved from recipe + topology + flags.
- A **Submission** flows from a worker's habitat to its **submitTo** peer's **Canonical Sandbox**.
- An approval bubbles up the **Supervisor** chain until a peer with a UI handles it.
- A **Mesh** is either **Static Topology**-launched or **Seed Agent**-grown; both share one **Bus Root** per deployment.
- An **Atomic Delegate** is a degenerate single-call mesh: ephemeral peer, supervisor = caller, submitTo = caller, torn down on return.
- A **Kanban** spawns one **Foreman** per ready issue file (V1). The Kanban persists; the Foreman is ephemeral, ending when it submits its branch.
- A **Foreman** **Atomic-Delegates** to **Workers** mid-**Ralph Loop** for ad-hoc specialist help; Workers do not read or write the issue tree.
- A **Mesh** wired to a **Project** pauses (no Foremen running) when no issue file is ready; it wakes when the issue-watcher extension fires.

## Example dialogue

> **Dev:** "If the analyst peer queues an edit and ships it as a submission, where does the file actually get written?"
> **Domain expert:** "To the analyst's **submitTo** peer's **Canonical Sandbox**. The analyst's own **Scratch Sandbox** stays clean — it never owns artifacts."

> **Dev:** "What if the analyst's supervisor doesn't have a UI?"
> **Domain expert:** "The supervisor's LLM picks `escalate`; the rail forwards to its own supervisor; recurses until a peer with `ctx.hasUI` is reached — usually a `human-relay`."

> **Dev:** "How is `delegate` different from `mesh_spawn`?"
> **Domain expert:** "`delegate` is **Atomic Delegate** — one shot, ephemeral, results queue into your deferred-confirm rail. `mesh_spawn` is for long-running peers in a **Seed Agent**'s mesh; you reach them with `agent_call`."

## Flagged ambiguities

- "**sandbox**" was used to mean three different things — fs containment, the whole agent surface, the worker's working directory. Resolved: **Habitat** is the whole perimeter; **Scratch Sandbox** and **Canonical Sandbox** are the two FS slices.
- "**agent**" was overloaded between the role (recipe) and the instance (running peer). Resolved: **Role** for the kind, **Peer** for the instance.
- "**delegation**" used to mean both "subprocess via `agent-spawn`" and "any worker dispatch." Resolved: **Atomic Delegate** is the single-tool spawn-and-collect; long-running worker dispatch is just `mesh_spawn` + `agent_call`.
- "**worker**" pre-V1 was an avoid-term meaning "Atomic Delegate child" (see ADR-0001's prose, where the spawned peer is called a "worker"). V1 Ralph-Loop architecture promotes **Worker** to a named **Role**: a specialist a **Foreman** delegates to mid-loop. The pre-V1 ADRs (0001–0003) read in the older sense; the V1 **Roles** section above is canonical for new docs.
