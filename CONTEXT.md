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
A running pi process bound to a **Bus Root**, addressed by its **Instance Name**.
_Avoid_: agent instance, child, worker (workers and supervisors are both peers)

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
Single-tool 1→1 spawn-call-collect; queues the worker's **Submission** into the caller's deferred-confirm rail; tears the peer down.

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
