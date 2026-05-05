# Host-relay spawn; the host owns the only PTY pool

A worker's `mesh_spawn` tool is a *thin client* that round-trips a `spawn-request` envelope through the host's launcher socket; the host's `mesh-mux` extension is the *only* peer that performs spawns and the *only* peer that owns a PTY pool. Every peer in the **Mesh** — direct child of the host or transitive descendant via worker-driven spawns — has its PTY in the host's pool, in the host's `__launcher__.sock` registry, and in the host's `/focus` tree. The decentralised peer-to-peer **Bus** is unchanged: data-plane envelopes (`message`, `submission`, `approval-request`, `approval-result`, `revision-requested`, `shutdown`) flow socket-to-socket between named peers. The launcher socket carries control-plane and spawn-protocol envelopes only.

## Why

- **Tree-wide `/focus` visibility falls out of single-pool ownership.** Because every peer's PTY lives in the host's pool, the human at the launcher TUI can `/focus <any peer>` regardless of spawn depth. Multi-tier focus navigation (focus-on-worker, then-focus-on-its-child) — which a recursive multiplexer would force — collapses into one flat focus space.
- **The host's "specialness" stays at the terminal layer, not the bus layer.** The host is privileged because it owns the human's terminal; it is *not* privileged because it has a special bus identity, special envelope handling, or human-relay semantics. ADR-0004 and ADR-0006 retired the human-relay anti-pattern; this ADR keeps that retirement intact by making host-vs-worker a question of *physical resources* (PTY, terminal, launcher socket) rather than *protocol role*. The host binds a normal bus socket as a normal peer; it just *also* runs `mesh-mux`.
- **Spawn validation centralises naturally.** The host has every peer's parsed recipe in memory (it spawned them). Validating that worker-1's `mesh_spawn(recipe: editor)` call references a recipe in worker-1's `spawns:` block, computing the worker-1-scoped habitat overlay (resolving `$spawner`, `@$myGroups`, group references), allocating the worker-1's-namespace cohort entry — all of this runs against state the host already owns. Decentralised spawn would require either replicating recipe state across spawning peers or query-on-demand, both with race conditions.
- **Recursive spawn produces a single coherent process tree.** When worker-1 spawns child editor-1 via host-relay, editor-1's parent process is the host's `node-pty` spawn (just like worker-1's was). On host crash or `/quit`, the entire tree dies via OS process-tree cleanup. Decentralised spawn would produce a tree of trees with looser cleanup semantics; under the cascade-kill rule (Q7 / ADR-0007's hard-cascade decision), the looser tree is harder to reason about.
- **The launcher socket already carries the right shape.** ADR-0004's launcher socket protocol carries control-plane envelopes (focus, pin, decisions, tail) between every peer and the host. Adding spawn envelopes to the same transport reuses an established pattern (peers connect via `launcher-bridge`; host binds via `mesh-mux`); there's no new socket to bind, no new credential exchange, no new fan-out logic.

## Considered alternatives

- **(α) Decentralised spawn, recursive PTY pools.** Each spawning peer is itself a `mesh-mux` instance for its descendants; binds its own launcher-socket-equivalent; owns its own PTY pool. Multi-level focus navigation. Rejected: every spawning peer pays node-pty + xterm-headless + an extra Unix socket bind; deep nesting compounds the cost; multi-level focus is awkward UX (the user has to remember which sub-mux to address); host-vs-worker stops being a clean role distinction. The recursive symmetry isn't paying for itself.
- **(β) Decentralised spawn, headless descendants.** Spawning peers spawn directly (no PTY allocated for grand-children); descendants run pi in non-PTY mode. Rejected: introduces a two-tier visibility model (direct children PTY-visible; deeper descendants invisible) that breaks "any peer in the mesh is observable from the human's terminal." The user can't `/focus` a stuck grand-child to debug it.
- **(γ) Host-relay over the data bus rather than the launcher socket.** Worker's `mesh_spawn` sends a `spawn-request` envelope to the host's normal bus socket (not the launcher socket); spawn-result returns the same way. Rejected: forces the host into the data-bus routing path for what is structurally a control operation; couples spawn protocol latency to bus envelope ordering rules; complicates the bus protocol with "is this a peer-to-peer message or a privileged spawn request?" disambiguation. The launcher socket is the right transport because spawn is fan-in/fan-out control, not peer-to-peer data.
- **(δ) Spawn collateralisation: workers spawn directly but register the resulting PTY back to the host.** Compromise between α and γ. Rejected: the spawn process is a child of whoever called `child_process.spawn`; "donating" a PTY across processes requires SCM_RIGHTS file-descriptor passing, which works on Unix but adds a fragile platform-specific code path for marginal benefit. Host-relay spawn keeps process ownership where it belongs (the host) without FD juggling.
- **Folding launcher socket envelopes into the bus protocol with a reserved `__host__` recipient.** Considered as a "one transport" simplification. Rejected: launcher-control envelopes have fan-in/fan-out semantics (mesh-update is a host broadcast; focus-changed reaches all peers) that don't fit the bus's point-to-point model. Either the bus grows multicast primitives (large change) or every peer has to know the host's instance name (couples spawn-time identity to addressing). Keeping `__launcher__.sock` as a known-path control channel preserves both protocols' shape.

## Consequences

### Spawn protocol envelopes

```ts
// Sent worker → host on __launcher__.sock when worker calls mesh_spawn.
{
  kind: "spawn-request",
  msg_id: string,
  from: string,                 // spawner's instance name
  recipe: string,               // child recipe name
  name?: string,                // optional explicit name
  groups?: string[],            // optional group memberships at spawn time
  // Per-spawn overrides (override recipe-default wiring from spawner's spawns: block):
  escalatesTo?: string,
  submitsWorkTo?: string,
  messagesWith?: string[],
  acceptsWorkFrom?: string[],
  workspace?: { include: string[] },  // files seeded into worker's scratch sandbox
  ts: number,
}

// Sent host → worker on __launcher__.sock as the worker's tool result.
{
  kind: "spawn-result",
  msg_id: string,
  in_reply_to: string,          // matches spawn-request.msg_id
  ok: boolean,
  name?: string,                // assigned instance name on success
  error?: string,               // on failure (e.g. "recipe not allowed", "empty group")
  ts: number,
}
```

### `mesh-mux` extension responsibilities (host-only)

Self-gates on `--is-host`. When active:

1. **Bind `${BUS_ROOT}/__launcher__.sock`** with the existing `launcher-socket.mjs` shape.
2. **Process `initial_mesh:` at session_start** before yielding to the LLM. Pre-allocates names for all entries (so `$siblings` resolves correctly even for the first spawn in the cohort), spawns each via the same machinery used for runtime `spawn-request`s, populates the cohort registry.
3. **Receive `spawn-request` envelopes**, validate against the spawner's parsed recipe (`spawns:` allowlist; group references; field-type rules per ADR-0008), resolve the worker's habitat overlay (group references, `$spawner`, `$siblings`, `$myGroups`), spawn the child via the host's `PtyPool`, register the new peer in the cohort registry, broadcast `mesh-update` to visible peers, reply `spawn-result` to the spawner.
4. **Own the focus controller, decisions queue, bus-tail buffer.** Same module shapes as today's `scripts/_lib/`, consumed via `createRequire`.
5. **Respond to `/focus`, `/pin`, `/decisions`, `/tail` slash commands** received from any peer's `launcher-bridge`. Same protocol as today.
6. **Cascade-kill on session_shutdown.** Walk the cohort registry's spawn tree, send `shutdown` envelopes to every descendant, wait up to 2s, SIGTERM stragglers via `PtyPool.killAll()`.

### `mesh-spawn` extension (every peer with non-empty `spawns:`)

Loaded universally via `peer.yaml` template; activates the `mesh_spawn` and `mesh_kill` tools only when the recipe's `spawns:` is non-empty. The tools are thin clients:

- **`mesh_spawn`**: builds a `spawn-request` envelope from the parameters; sends via `launcher-bridge` to the host's launcher socket; awaits `spawn-result` (default 5min timeout); returns `{name}` or `{error}` to the LLM.
- **`mesh_kill`**: builds a `shutdown` envelope addressed to the named peer; sends via the host's launcher socket (since `mesh_kill` may target a peer outside the caller's visibility — the host is authoritative on liveness); the host then routes the shutdown envelope onto the data bus to the target peer.

The host itself does not need `mesh_spawn` as a *tool* for `initial_mesh:` to work — the runner-driven path bypasses tools. A host recipe that *also* wants to dynamically spawn at runtime declares `mesh_spawn` in `tools:` (or, equivalently, declares non-empty `spawns:` and lets the implicit-wiring add it).

### Bus protocol (unchanged)

The decentralised peer-to-peer bus continues to carry data-plane envelopes (`message`, `submission`, `approval-request`, `approval-result`, `revision-requested`) between named peers via `${BUS_ROOT}/${name}.sock`. Sender-side fan-out (per ADR-0008) for group references in list fields runs in the sending peer's `peer-bus` extension; the bus sees only point-to-point envelopes. The new `shutdown` envelope kind also flows on the data bus (it's addressed to a specific peer); host-emitted shutdowns route via `mesh-mux` writing to the target peer's bus socket.

### Race window: spawn-result vs. data-bus envelopes

A worker's `mesh_spawn` tool returns to the LLM only after the host's `spawn-result` lands. Before the LLM acts on the new peer's name, `mesh-update` envelopes have already broadcast (the host emits them before sending `spawn-result`), so visible peers' cohort caches are populated. The remaining race — a freshly-spawned peer sending an envelope to a sibling whose `mesh-update` hasn't landed yet — is handled by the unknown-sender lookup mechanism in `peer-bus`: receiving peer queries the host to confirm the sender's visibility before rejecting.

### Migration

- `scripts/_lib/launcher-envelope.mjs` gains `spawn-request` / `spawn-result` envelope types; the existing wire format is otherwise unchanged.
- `pi-sandbox/.pi/extensions/atomic-delegate.ts`'s spawn machinery (process spawn via `run-agent.mjs`, dispatch hook registry, habitat-overlay computation) factors into a shared `_lib/peer-spawn.ts` consumed by the new `mesh-mux.ts` and the new `mesh-spawn.ts`. `atomic-delegate.ts` itself is deleted (per ADR-0007).
- `scripts/launch-mesh.mjs` shrinks to a thin entry-point shim that resolves `pi-sandbox/agents/<host>.yaml` and execs `scripts/run-agent.mjs <host> --is-host`.
- `scripts/_lib/{pty-pool,multiplexer,launcher-socket,decisions-queue,focus-controller,bus-tail}.mjs` become dependencies of `mesh-mux.ts` (loaded via `createRequire`).
- Tests for `pty-pool`, `multiplexer`, `launcher-socket`, `focus-controller`, etc. carry over unchanged; their consumers shift from `launch-mesh.mjs` to `mesh-mux.ts`.
- The `--inherit-pty` flag (or whatever signals "stdio is already inside a managed PTY") that today's `run-agent.mjs` reads from `PI_MESH_PEER` is replaced by the absence of `--is-host` when invoked via `mesh_spawn`: a worker's `run-agent.mjs` always inherits stdio (its parent is the host's `node-pty`), and a host always allocates its own PTY (it owns the terminal).
