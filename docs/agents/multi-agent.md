# Multi-agent — mesh_spawn, peer messaging, supervisor

Parent: [`docs/agents.md`](../agents.md). For declaring meshes, see
[`topology.md`](./topology.md); for running and observing one, see
[`testing.md`](./testing.md).

## spawn vs. talk

Two orthogonal extensions cover the two distinct relationships a recipe
might want with another agent. `mesh-spawn` is opt-in via `extensions:` +
`tools:` (or via `spawns:` in the recipe, which auto-adds it);
`peer-bus` is also opt-in via `extensions:` + `tools:`. A recipe can use
either, both, or neither.

### `mesh-spawn` — long-lived worker spawn over the bus

Wired when the recipe includes `mesh-spawn` in `extensions:` (or declares
`spawns: [a, b, …]`). Registers two tools:

- `mesh_spawn({recipe, task, groups?, sandbox?})` — spawns
  `pi --recipe <recipe>` in a fresh tmpdir scratch root via
  `buildRecipeChildArgv` (in `packages/engine/agent/lib/child-spawn.mjs`),
  starts the worker with the given task, and returns immediately with the
  worker's name. The worker is long-lived — it persists until killed.
- `mesh_kill({name})` — sends a `shutdown` envelope to the named worker
  and removes it from the registry.

**Worker habitat overlay.** Each spawned worker is locked to the
caller via a `--topology-overlay` JSON blob set by the extension:

```json
{
  "supervisor": "<callerName>",
  "submitTo": "<callerName>",
  "acceptedFrom": ["<callerName>"],
  "peers": ["<callerName>"]
}
```

So the worker can only message the caller, can only submit to the
caller, and won't accept typed inbound envelopes from anyone else.
The overlay overrides whatever peer fields the worker recipe declares.

**Admission.** When the worker ships a submission to the caller's bus
socket, `peer-bus.handleIncoming` checks the `__pi_mesh_spawn_is_my_worker__`
predicate (set by `mesh-spawn` at init). If the worker name is in the
registry, the envelope is admitted even if it isn't in the static
`acceptedFrom` list — so dynamically-spawned names don't need to be
pre-listed in the topology.

**Pre-flight checks** in `mesh_spawn.execute`:

1. **Recipe allowlist** — `params.recipe` must be in
   `getHabitat().spawns`. Error: `recipe_not_allowed`.
2. **Recipe exists** — `pi-sandbox/agents/<recipe>.yaml` must exist.
   Error: `recipe_not_found`.
3. **Groups validation** — group names must not start with `_`.
   Error: `reserved_group_name`.

**Cleanup.** `session_shutdown` cascade-kills all registered nodes.
`mesh_kill` kills a specific worker on demand.

Worked examples: `pi-sandbox/agents/writer-foreman.yaml` (single-
recipe foreman driving `deferred-writer`, walked through in
[`worked-examples.md`](./worked-examples.md)) and
`pi-sandbox/agents/delegator.yaml` (general-purpose planner with a
broad allowlist).

### `peer-bus` — async peer messaging (long-lived, named)

Registers four tools and one CLI flag:

- `peer_send({to, body, in_reply_to?})` — fire-and-forget. Connects to
  `${BUS_ROOT}/${to}.sock`, writes one JSON envelope, returns
  `{msg_id, delivered}`. `peer offline` / `timeout` are normal failure
  modes (no retry, no offline queue).
- `peer_inbox({since_ts?, peek?})` — pull buffered envelopes. By
  default returned messages are cleared from the inbox; `peek=true`
  keeps them.
- `peer_list()` — probe `${BUS_ROOT}/*.sock` for live peers; clean up
  stale socks left by crashed peers.
- `peer_call({to, body, timeout_ms?})` — request/response call to a
  peer. Blocks until a reply arrives or the timeout expires.
- `--agent-bus-root <dir>` — the rendezvous directory. Resolution
  order: this flag → `~/.pi-agent-bus/<basename of sandbox-root>`.
  The runner sets the flag automatically and accepts
  `--agent-bus <dir>` (parallel to `--sandbox <dir>`) to override.

Each agent listens on `${BUS_ROOT}/${name}.sock` (name comes from
`--peer-name`, which the engine sets to a generated
`<breed>-<shortName>` slug — unique per instance — unless the
`--peer-name <override>` wins). The engine probes the
bus root before generating so two roots launched in different terminals
won't collide; explicit overrides are needed when peers want to address
each other by a stable role name (e.g. `planner`, `worker-a`). Incoming
messages buffer in an in-memory inbox and, between turns, are pushed
into the agent's next turn via `pi.sendUserMessage("[from <peer>]
<body>")`. Mid-turn arrivals are held in a `pendingDuringTurn` queue
and drained at `turn_end` so the live LLM call is never interrupted.

The bus root deliberately lives **outside** `--sandbox-root` so the
`sandbox` extension's path-rejection doesn't trip on socket paths. The
bus extension never invokes path-bearing built-in tools, so the sandbox
allowlist is unaffected.

Stale-sock handling: on bind, `EADDRINUSE` triggers a probe-connect; if
the previous owner refuses, the sock is unlinked and bind retried once.
A live peer at the same name fails loudly. On send, `ECONNREFUSED` /
`ENOENT` opportunistically unlinks the dead sock and returns
`{delivered:false, reason:"peer offline"}`.

v1 defaults intentionally deferred to later: no auth (filesystem perms
only), no offline queue, no synthesised request/response correlation
beyond the optional `in_reply_to` field, hard-fail on name collision.

Worked example: `pi-sandbox/agents/peer-chatter.yaml`.

### Why two systems and not one

`mesh_spawn` is a fire-and-supervise pattern: the caller spawns a long-lived
worker, the worker submits work over the bus, and the caller reviews it via
`respond_to_request`; peer-talk is async long-lived messaging
(stable named peers, `pi.sendUserMessage` delivery). Both ride the same
Unix-socket bus protocol — `mesh_spawn` workers use the same `submission`
envelope kind that the supervisor inbound rail handles — but the
recipe-level affordances differ enough that keeping them as two independent
extensions lets recipes mix exactly the relationship they need.

## Mandatory safety rails for sub-agents

When an extension spawns a child `pi` process:

- Pass `--no-extensions` to the child — prevents recursive sub-agents.
- Whitelist the child's tools (`--tools read,grep,...`) to match its role.
- Forward the parent's `AbortSignal` and truncate captured stdout (~20 KB).
- Match the tier to the child's role: `$TASK_RABBIT_MODEL` for workers,
  `$LEAD_HARE_MODEL` for reviewers, `$RABBIT_SAGE_MODEL` for orchestration.

See `pi-sandbox/skills/pi-agent-builder/references/` for recipe-level detail.

## Supervisor inbound rail

The **supervisor** extension (`packages/engine/agent/extensions/supervisor.ts`) implements
the inbound review loop described in [ADR-0003](../adr/0003-supervisor-llm-in-review-loop.md).
The extension registers the `respond_to_request` tool and a globalThis dispatch hook
that `agent-bus` calls when a typed non-message envelope arrives.

### Automatic wiring

`supervisor`, `intercept`, and `respond_to_request` are **baseline** — loaded for
every agent by default. Both extensions self-gate via `getHabitat().acceptedFrom`:
when the topology overlay sets no inbound peers, the supervisor and intercept rails
are silent no-ops and the `respond_to_request` tool returns a "no pending request"
message rather than crashing.

### Inbound envelope kinds handled

| Kind | Source | Rail action |
|------|--------|-------------|
| `approval-request` | peer in `acceptedFrom` | Queued; model prompted |
| `submission` | peer in `acceptedFrom` | Queued; model prompted |
| Either kind from unknown peer | anyone not in `acceptedFrom` | Dropped silently (stderr when `--debug`) |
| `message` | any peer | Free-flow (unrestricted, existing behaviour) |

### Four-action flow via `respond_to_request`

When the model receives an inbound prompt it uses:

```
respond_to_request({msg_id, action, note?})
```

| Action | Effect |
|--------|--------|
| `approve` on `approval-request` | Sends `approval-result(approved:true)` to original sender; closes thread |
| `approve` on `submission` | Applies artifacts to canonical filesystem (`getHabitat().scratchRoot`), then sends `approval-result(approved:true)` on success or `approval-result(approved:false, note:"apply failed: …")` on SHA-mismatch or apply error; closes thread either way |
| `reject` | Sends `approval-result(approved:false)` to original sender; closes thread. Does **not** touch the filesystem. |
| `revise` | Sends `revision-requested(note)` to original sender; thread stays open (note **required**). Does **not** touch the filesystem. |
| `escalate` | Forwards to `getHabitat().supervisor` via bus; relays result back to sender; closes thread |

**Submission apply semantics (Phase 4b):** `approve` on a `submission` envelope runs a two-pass verify-then-apply:

1. **Verify pass** — all artifact SHAs are checked against the current canonical filesystem without touching any files. A SHA mismatch on any artifact in the batch aborts the entire batch (atomic).
   - `write`: no SHA verification (content is new; the SHA field is informational).
   - `edit`: current file content must hash to `sha256OfOriginal`.
   - `move`: source file must hash to `sha256OfSource`; destination must not exist.
   - `delete`: current file content must hash to `sha256`.
2. **Apply pass** — artifacts are applied in fixed priority order (writes → edits → moves → deletes), regardless of the order they appear in the envelope. This matches `deferred-confirm`'s priority order so compositions like "edit X then move it to Y" work deterministically.

Revision cycles are **capped at 3 per thread** (keyed by the root `msg_id`). After
the cap, only `approve` or `reject` are accepted; a further `revise` returns an
error without sending anything.

The model-facing prompt fragment (`supervisor.prompt.md`) is loaded automatically
when the supervisor extension is active; it contains action descriptions and usage
examples.

### Testable core

The action routing, acceptedFrom enforcement, and revision cap all live in
`packages/engine/agent/lib/supervisor-inbox.ts` with a matching
`supervisor-inbox.test.ts`. The `supervisor.ts` extension is a thin pi
wrapper; tests can exercise the full action graph without a live model.

### Escalation and the escalation primitive

`requestHumanApproval` lives in the engine's `_lib/escalation.ts` and is
imported by `deferred-confirm.ts`. It routes only `ctx.hasUI` →
`ctx.ui.confirm` or loud-fails to stderr; cross-agent escalation flows
over the bus as an `approval-request` envelope handled by the supervisor
rail (the `escalate` action sends to `getHabitat().supervisor` directly,
no rpc-sock fallback).
