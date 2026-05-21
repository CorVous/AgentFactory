# AgentFactory

Workspace for building and running multi-agent compositions on top of `@earendil-works/pi-coding-agent`. Agents are pi processes composed via **Recipes** that declare both their **Role** and the wiring of any peers they spawn; the system enforces containment via **Rails** so each peer's blast radius is explicit and auditable.

## Language

### Identity

**Recipe**:
A YAML file in `pi-sandbox/agents/<name>.yaml` defining a **Role** — prompt, tools, model **Tier**, role-specific extras (skills, additional **Rails** in its own `extensions:` list), and the wiring of any peers this role spawns (`spawns:` block, with optional symbolic peer references like `$spawner` and `$siblings`). May also declare `initial_mesh:` — peers spawned at session_start before the LLM's first turn. Every recipe extends a **Template** (defaulting to `peer`) which provides the universal rail bundle.
_Avoid_: agent file, config

**Template**:
A YAML file in `pi-sandbox/templates/<name>.yaml` carrying only the universal `extensions:` list — the **Rails** every **Recipe** that extends it gets. The shipped default `peer` template carries every rail a peer needs (containment, supervisor inbound, bus, launcher integration, mesh-spawn capability). Recipes append further rails (e.g. `deferred-write`, `no-edit`) via their own `extensions:` field.
_Avoid_: preset, profile

**Role**:
The reusable identity a **Recipe** defines.
_Avoid_: agent type, kind

**Peer**:
A running pi process bound to a **Bus Root**, addressed by its **Instance Name**. Every peer binds a bus socket at `session_start`, even if its tool palette excludes peer-talk tools (`peer_send`, `peer_call`, etc.).
_Avoid_: agent instance, child, worker (workers and supervisors are both peers)

**Instance Name**:
Unique `<breed>-<shortName>` slug per running peer; doubles as bus-socket identity. Recipe authors may override with an explicit `name:` on `initial_mesh:` entries when cross-references in wiring fields require a stable literal.
_Avoid_: agent name (ambiguous between role and instance), id

**Tier**:
A model class — `RABBIT_SAGE_MODEL` (planner), `LEAD_HARE_MODEL` (overseer), `TASK_RABBIT_MODEL` (worker).

**Host**:
The single **Peer** at the top of a **Mesh**'s **Spawn Tree** — the root invocation, started directly by the human via `pi --recipe <recipe>`. Structurally privileged: owns the only PTY pool, the only `__launcher__.sock` binding, and the cohort registry for the entire mesh. The host is also the **Top Supervisor** by definition (escalations bubble up to whoever has no spawner; that's the host). Host-vs-worker is determined at runtime by the `--is-host` flag, not by recipe content. Tier ≥ `LEAD_HARE_MODEL` is required (the host is the final review surface for `escalate`-from-top, and an LLM is in the loop).
_Avoid_: launcher (the launcher's role moved into the host's `mesh-mux` extension), root agent

**Spawner**:
The **Peer** that performed `mesh_spawn` (or whose `initial_mesh:` runner-driven boot pre-spawned this peer). For peers in `initial_mesh:`, the spawner is the **Host**. The spawner ↔ child edge is structurally visible and addressable regardless of group membership. Recipes use `$spawner` to reference this peer symbolically.

### Containment

**Habitat**:
Per-instance containment perimeter for one **Peer** — scratch FS, peer wiring (escalatesTo, submitsWorkTo, messagesWith, acceptsWorkFrom), tools, model — resolved at session start; **Rails** read from it. List-valued allowlist fields are *live-mutable* under group-aware wiring: as cohort membership changes, the host broadcasts `mesh-update` envelopes and each peer's cohort tracker updates the materialised list. Singular fields (escalatesTo, submitsWorkTo) are baked at spawn time and stay concrete strings.
_Avoid_: sandbox (overloaded), environment, scope, surface

**Scratch Sandbox**:
A peer's compute-only filesystem, wiped between calls, never the source of truth.
_Avoid_: worker sandbox, working directory

**Canonical Sandbox**:
A peer's source-of-truth filesystem; **Submissions** apply here.
_Avoid_: real sandbox, output directory

**Rail**:
An extension that enforces one axis of a **Habitat** — FS containment, write-existence, peer allowlist, supervisor handler, mux/spawn capability, etc.

### Communication

**Bus Root**:
Directory holding peer Unix sockets at `${BUS_ROOT}/${instance_name}.sock`, plus the host's control-plane socket at `${BUS_ROOT}/__launcher__.sock`. The bus itself is decentralised — every peer binds its own socket; data-plane envelopes flow point-to-point between named peers without a central relay.

**Mesh**:
A running collection of **Peers** sharing one **Bus Root**, rooted at a single **Host** and structured as the **Host**'s transitive **Spawn Tree**. Every mesh has exactly one host; the host's pi process is the human's terminal-owner and the mesh's lifetime tracks the host's process. The human participates only through the **TUI**.

**Spawn Tree**:
The directed tree formed by the spawner relationship — the **Host** at the root, every spawned peer as a child of its **Spawner**. The mesh's full graph (who-can-talk-to-whom) is the spawn tree intersected with **Group** memberships and the symbolic peer references declared in each recipe's `spawns:` block.

**Sibling Cohort**:
The set of **Peers** spawned by the same **Spawner**. Resolved by `$siblings` symbolically; visibility-filtered to peers sharing at least one **Group** within the spawner's namespace. The cohort grows and shrinks as the spawner spawns and as members exit; the cohort tracker on each peer maintains a live cache via `mesh-update` envelopes.
_Avoid_: cohort alone (overloaded), group (Group is a labeled subset)

**Group**:
A labeled subset of **Peers** within a single **Spawner**'s namespace. Membership is declared per-instance at spawn time (`groups:` field on `initial_mesh:` entries and as a parameter to `mesh_spawn()`); one peer may belong to multiple groups; ungrouped peers join the implicit `@_default` group. **Spawner-scoped**: the same group name under different spawners refers to disjoint sets, never shared. **Visibility-scoped**: a peer can address only peers it shares at least one group with within its spawner's namespace, plus the structural spawner ↔ child edge. Reference syntax: `@<group>:<recipe>` for recipe-typed lookup, `@<group>` for any recipe; symbolic forms `@$myGroups:<recipe>` and `@$myGroups` resolve to the resolving peer's own group memberships.
_Avoid_: cluster, pool, namespace (overloaded)

**Submission**:
A typed envelope from a worker to its **submitsWorkTo** peer carrying staged artifacts (writes, edits, moves, deletes) for review and atomic apply.

**Bundle**:
Files seeded into a worker's **Scratch Sandbox** by its supervisor at call time, with SHA-256 receipts for drift detection at apply.
_Avoid_: workspace, payload

**escalatesTo**:
A peer's escalation target — the singular peer to whom `approval-request` envelopes flow when the peer's LLM picks `escalate` via `respond_to_request`. Chains upward through declared `escalatesTo:` links until the **Host** (the **Top Supervisor**), where `escalate` surfaces to the human via the **TUI** rather than another peer.
_Avoid_: supervisor (was the field name pre-rename)

**submitsWorkTo**:
A peer's submission target — the singular peer that receives **Submissions**. Defaults to `escalatesTo` when unspecified; explicit override differentiates the cases where submissions and approvals route differently (e.g. writer submits drafts to a reviewer but escalates approvals to the authority).
_Avoid_: submitTo (pre-rename)

**acceptsWorkFrom**:
A peer's inbound allowlist for typed control envelopes — `submission` and `approval-request`. The list is auto-populated as the cohort grows: when the host spawns a new peer with `escalatesTo: <this>` or `submitsWorkTo: <this>`, this peer's `acceptsWorkFrom:` gains the new peer via `mesh-update`. Recipe authors rarely set it explicitly. Visibility scoping pre-filters envelopes before the rail consults this list.
_Avoid_: acceptedFrom (pre-rename)

**messagesWith**:
A peer's bidirectional allowlist for free-flow `message` envelopes (the unrestricted conversational channel, distinct from typed control envelopes). Group references expand at spawn time and stay live as cohort changes; sender-side fan-out runs in the sender's `peer-bus` extension when group references resolve to multiple members.
_Avoid_: peers (pre-rename — overloaded with capital-P **Peer**)

**Top Supervisor**:
The peer at the head of a **Mesh**'s escalation chain — the unique peer whose `escalatesTo` field is unset. Always the **Host** by construction (the host has no spawner, so no default `escalatesTo`). Tier ≥ `LEAD_HARE_MODEL` required (the chain ends at this peer's LLM, so a Task Rabbit at the top means the cheapest model is the final approver). There is exactly one per mesh.

### Human Surface

**TUI**:
The **Host**'s pi session, multiplexed by its `mesh-mux` extension to render any **Peer** in the mesh on demand. Each peer runs in its own PTY in the host's pool; the host's own session paints to the real terminal directly; worker PTYs are rendered into pi `ctx.ui.custom({ overlay: true })` overlays on `/focus`. Mesh status (peers list, **Decisions Queue**) renders inside each peer's pi TUI as a widget pinned directly above the input editor (`ctx.ui.setWidget` with `placement: "aboveEditor"`), populated by the `mesh-rail` baseline extension; the launcher emits no chrome of its own. Slash commands (`/focus`, `/pin`, `/tail`, `/decisions`, …) registered by a baseline `launcher-bridge` extension on every peer are the human's command channel; they emit control envelopes to the host's launcher socket. The human is *not* a peer — there is no `human-relay` peer in this model. See [ADR-0004](docs/adr/0004-launcher-multiplexed-tui.md), its 2026-05-01 amendment, and its 2026-05-04 amendment.

**Focused Peer**:
The peer whose pi session the **TUI** is currently rendering. The host (`/focus host` or default at startup) renders the host's normal pi TUI; any other focus opens a full-screen overlay painting that peer's xterm-headless buffer. Human keystrokes inject as user-messages into the focused peer's pi process. Movable at runtime via `/focus`.

**Intercept**:
When the **TUI** is the **Focused Peer** for X and X is about to invoke `respond_to_request` on an inbound `submission` / `approval-request`, the rail on X cancels X's LLM turn and surfaces the prompt via X's own `ctx.ui.confirm` — pi's TUI renders the dialog in the same pane the human is already watching. The human's pick goes on the wire as if it were the LLM's. Free-flow `message` envelopes are unaffected by focus.

A focus change from X→Y is a **hard cancel** on X: any in-flight `ctx.ui.confirm` on X is dismissed and the original prompt is re-injected to X's LLM as a fresh `respond_to_request` turn. The exception is **pin** — a pinned decision survives focus shifts and is never returned to the LLM.

**Decisions Queue**:
Pending human decisions surfaced by **Intercept** or by `escalate` from the **Top Supervisor**, summarized as a count badge in the `mesh-rail` widget and expanded via `/decisions` into a focus-capturing overlay with pin/dismiss affordances. Default lifecycle is **fluid**: shifting focus away from a transient intercept dialog re-injects the original prompt to the peer's LLM (fresh turn). The human can **pin** a decision to make it sticky — it stays in the queue across focus changes and the LLM does not resume.

### Patterns

**Initial Mesh**:
Optional `initial_mesh:` block on a host **Recipe** listing peers to pre-spawn at `session_start`, before the host's LLM gets its first turn. Runner-executed (the host's `mesh-mux` extension performs the spawns directly, not via the LLM's tool calls), so works regardless of whether `mesh_spawn` is in the host's tools or whether each pre-spawned recipe is in `spawns:`. Each entry carries a `recipe:`, optional `name:` (for cross-references), optional `groups:` (for namespacing), and optional per-spawn wiring overrides. The "fixed cohort, no further-spawn capability" pattern (e.g., a moderator with three critics that cannot create more critics) is built by combining `initial_mesh:` with empty/absent `spawns:`.

**Atomic Spawn-and-Collect**:
The single-shot worker pattern — `mesh_spawn(recipe)` → drive via `peer_send` → worker submits → spawner approves at end-of-turn → `mesh_kill`. Replaces the deprecated `delegate` tool, which was deleted when the recipe artifact subsumed launches (per ADR-0007 and ADR-0001's 2026-05-04 amendment). End-of-turn batched approval — multiple atomic submissions in one turn rendering as one composite dialog — is now a property of the supervisor inbound rail rather than this pattern, so every supervisor benefits, not just delegating ones.
_Avoid_: atomic delegate (pre-rename — `delegate` is deleted)

### Supervisor Actions

When inbound rail surfaces a **Submission** or approval request, the supervisor's LLM picks via `respond_to_request`:

- **Approve** — rail applies artifacts to canonical, replies success.
- **Reject** — rail discards, replies failure.
- **Revise** — rail asks the worker to redo with feedback; thread preserved; worker keeps its in-memory queue.
- **Escalate** — rail forwards to *this* supervisor's own supervisor; relays the result back. From the **Top Supervisor** (the **Host**), surfaces to the human via the **TUI**.
