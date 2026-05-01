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
A running pi process bound to a **Bus Root**, addressed by its **Instance Name**. Every peer binds a bus socket at `session_start`, even if its tool palette excludes peer-talk tools (`agent_send`, `agent_call`, etc.).
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
A running collection of **Peers** sharing one **Bus Root**. Humans never run a mesh directly; every mesh is launched under a **Top Supervisor** (tier ≥ `LEAD_HARE_MODEL` recommended) and the human participates only through the **TUI**.

**Submission**:
A typed envelope from a worker to its **submitTo** peer carrying staged artifacts (writes, edits, moves, deletes) for review and atomic apply.

**Bundle**:
Files seeded into a worker's **Scratch Sandbox** by its supervisor at call time, with SHA-256 receipts for drift detection at apply.
_Avoid_: workspace, payload

**Supervisor**:
A peer's escalation target for approvals; chains upward through declared `supervisor:` links until the **Top Supervisor**. `escalate` from the Top Supervisor surfaces to the human via the **TUI** rather than a peer.

**Top Supervisor**:
The peer at the head of a **Mesh**'s escalation chain — the first peer whose `supervisor` field is unset. Tier ≥ `LEAD_HARE_MODEL` is strongly recommended (the chain ends at this peer's LLM, so a Task Rabbit at the top means the cheapest model is the final approver); the launcher prints a warning but does **not** reject — the framework stays modifiable for testing, demos, and deliberate overrides. There is exactly one per mesh.

**submitTo**:
A peer's submission target; the peer that receives and applies the worker's artifacts.

### Human Surface

**TUI**:
Launcher-level interactive surface; the human's only interface to a running **Mesh**. Each peer runs in its own PTY with a full pi TUI alive; the launcher multiplexes via PTY pass-through — the **Focused Peer**'s output streams directly to the launcher's stdout, off-screen peers accumulate in virtual buffers, and a focus change paints the destination's accumulated state once before resuming pass-through. Mesh status (peers list, **Decisions Queue**) renders inside each peer's pi TUI as a `nonCapturing` overlay anchored top-right, populated by the `mesh-rail` baseline extension; the launcher emits no chrome of its own. Slash commands (`/focus`, `/pin`, `/tail`, `/decisions`, …) registered by a baseline `launcher-bridge` extension on every peer are the human's command channel; they emit control envelopes to a launcher-bound socket. The human is *not* a peer — there is no `human-relay` peer in this model. See [ADR-0004](docs/adr/0004-launcher-multiplexed-tui.md) including its 2026-05-01 amendment.

**Focused Peer**:
The peer whose pi session the **TUI** is currently bound to. Human keystrokes inject as user-messages into this peer's pi process via stdin. Movable at runtime; the topology may declare an initial default focus.

**Intercept**:
When the **TUI** is the **Focused Peer** for X and X is about to invoke `respond_to_request` on an inbound `submission` / `approval-request`, the rail on X cancels X's LLM turn and surfaces the prompt via X's own `ctx.ui.confirm` — pi's TUI renders the dialog in the same pane the human is already watching. The human's pick goes on the wire as if it were the LLM's. Free-flow `message` envelopes are unaffected by focus.

A focus change from X→Y is a **hard cancel** on X: any in-flight `ctx.ui.confirm` on X is dismissed and the original prompt is re-injected to X's LLM as a fresh `respond_to_request` turn. The exception is **pin** — a pinned decision survives focus shifts and is never returned to the LLM.

**Decisions Queue**:
Pending human decisions surfaced by **Intercept** or by `escalate` from the **Top Supervisor**, summarized as a count badge in the `mesh-rail` overlay and expanded via `/decisions` into a focus-capturing overlay with pin/dismiss affordances. Default lifecycle is **fluid**: shifting focus away from a transient intercept dialog re-injects the original prompt to the peer's LLM (fresh turn). The human can **pin** a decision to make it sticky — it stays in the queue across focus changes and the LLM does not resume.

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
- An approval bubbles up the **Supervisor** chain; `escalate` from the **Top Supervisor** surfaces to the human via the **TUI**.
- A **Mesh** is either **Static Topology**-launched or **Seed Agent**-grown; both share one **Bus Root** per deployment.
- An **Atomic Delegate** is a degenerate single-call mesh: ephemeral peer, supervisor = caller, submitTo = caller, torn down on return.

## Example dialogue

> **Dev:** "If the analyst peer queues an edit and ships it as a submission, where does the file actually get written?"
> **Domain expert:** "To the analyst's **submitTo** peer's **Canonical Sandbox**. The analyst's own **Scratch Sandbox** stays clean — it never owns artifacts."

> **Dev:** "What if the analyst's supervisor wants a human's call?"
> **Domain expert:** "It picks `escalate`. The rail walks the **Supervisor** chain upward; if the chain reaches the **Top Supervisor** and *that* peer also escalates, the rail surfaces the prompt on the launcher's **TUI**. No `human-relay` peer is involved — the human is outside the mesh."

> **Dev:** "What does it mean to focus the TUI on a peer?"
> **Domain expert:** "The peer's pi session renders in the TUI's main pane and the human's keyboard injects user-messages into it. If a `submission` lands on that **Focused Peer**, **Intercept** fires — the LLM turn cancels and the human picks the action. By default the dialog is fluid: shifting focus releases the decision back to the LLM. **Pin** it to keep it sticky in the **Decisions Queue**."

> **Dev:** "How is `delegate` different from `mesh_spawn`?"
> **Domain expert:** "`delegate` is **Atomic Delegate** — one shot, ephemeral, results queue into your deferred-confirm rail. `mesh_spawn` is for long-running peers in a **Seed Agent**'s mesh; you reach them with `agent_call`."

## Flagged ambiguities

- "**sandbox**" was used to mean three different things — fs containment, the whole agent surface, the worker's working directory. Resolved: **Habitat** is the whole perimeter; **Scratch Sandbox** and **Canonical Sandbox** are the two FS slices.
- "**agent**" was overloaded between the role (recipe) and the instance (running peer). Resolved: **Role** for the kind, **Peer** for the instance.
- "**delegation**" used to mean both "subprocess via `agent-spawn`" and "any worker dispatch." Resolved: **Atomic Delegate** is the single-tool spawn-and-collect; long-running worker dispatch is just `mesh_spawn` + `agent_call`.
- "**human**" was sometimes a peer (`human-relay.mjs`) and sometimes the operator at the keyboard. Resolved: the human is *not* a peer — they participate via the launcher's **TUI**. `human-relay` was retired by ADR-0004; cross-agent escalation flows over the bus to the launcher socket as well as between peers.
