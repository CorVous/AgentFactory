# Mesh subsumes delegation

Today's per-call `--rpc-sock` delegation primitive (`agent-spawn`) and the agent bus's `msg_id`/`in_reply_to` request/response are two implementations of the same idea — Unix-socket JSON-line request/response — re-implemented across three files. We will consolidate onto a single typed-envelope bus protocol; delegation collapses into the mesh; atomic 1→1 work survives as a thin `delegate` tool that queues a worker's **Submission** into the caller's existing deferred-confirm rail.

## Why

- **One wire format.** Adding a new envelope kind or a checksum currently has to touch `agent-spawn.ts`, `agent-status-reporter.ts`, and `deferred-confirm.ts`. After the deepening, the protocol has one home with one set of tests.
- **Trust split is physical.** Workers compute in their **Scratch Sandbox**; supervisors apply submissions to their **Canonical Sandbox**. A worker can't write outside its scratch without the supervisor's hand. Today's delegation only gates via approval; artifact-bearing submission ships the artifacts so the supervisor owns the apply step.
- **Persistent peer reuse.** Long-running peers accumulate context across calls (warm session, codebase already read). Spawn-and-die delegation throws this away.
- **Supervisor's LLM is in the loop.** Every supervisor handles inbound submissions/approvals via `respond_to_request` (approve / reject / revise / escalate). The rail routes; the model picks. This makes the supervisor a real review participant rather than a router.

## Considered alternatives

- **Keep delegation alongside mesh.** Rejected: leaves two separate RPC primitives doing the same thing, and `human-relay.mjs` already became a fourth implementer of the bus envelope without it ever being formalised.
- **Rail-only supervisor handling (no LLM in the loop).** Rejected: makes the supervisor a router with no review power, which collapses artifact-bearing submission back to authorisation-only and undoes the trust split.
- **Sub-mesh isolation enforced (per-spawner sub-bus).** Rejected for v1: allowlists do the scoping work cheaply; per-spawner sub-buses force every spawner to bind two sockets and complicate cross-bus debugging. Configurable isolation deferred.

## Consequences

- `pi-sandbox/.pi/extensions/agent-spawn.ts`, `agent-status-reporter.ts`, and the `--rpc-sock` flag are removed once recipes have migrated.
- Recipe schema gains `peers:`, `acceptedFrom:`, `supervisor:`, `submitTo:`; `noEditAdd`/`noEditSkip` and recipe-level `provider:` come off (provider moves to a default chain).
- `delegate` keeps its name but becomes a single tool call (was the two-tool `delegate` + `approve_delegation` dance).
- Every supervisor pays a model turn per inbound submission; tier choice (`LEAD_HARE_MODEL` vs `TASK_RABBIT_MODEL`) matters for supervisors handling many submissions.
- Migration ships in six phases, each independently safe: typed envelope → habitat materialiser → supervisor inbound rail → `deferred-*` ship submissions → atomic `delegate` replaces `agent-spawn` → topology + groups + status reporting.

---

> **Note (ADR-0004):** `human-relay` was retired by ADR-0004; cross-agent escalation flows over the bus to the launcher socket as well as between peers.

## Amendment (2026-05-04) — `delegate` collapses into `mesh_spawn`

ADR-0007 ("Recipes own the graph; launches are eliminated; meshes are host-grown") completes the collapse this ADR began. The atomic `delegate` tool — kept as a specialisation of the bus protocol when this ADR shipped — is removed in favour of a single spawn primitive `mesh_spawn(recipe, name?, sandbox?, groups?, …)` plus an explicit teardown `mesh_kill(name)`. The atomic-and-collect usage pattern (writer-foreman) becomes one usage of `mesh_spawn` rather than its own tool: the spawning peer calls `mesh_spawn`, drives the worker via `peer_send`, and calls `mesh_kill` after the submission applies. The end-of-turn batched-approval property — atomic-delegate's killer feature when multiple `delegate` calls land in one turn — moves up to the supervisor inbound rail (`_lib/supervisor-inbox.ts`): when multiple submissions arrive in one turn, they render as one composite `respond_to_request` prompt. This generalises batching to every supervisor, not just delegating ones. `pi-sandbox/.pi/extensions/atomic-delegate.ts` and `atomic-delegate.prompt.md` are deleted; the spawn machinery extracts to `_lib/peer-spawn.ts` consumed by both the new `mesh-spawn.ts` extension and the host's `mesh-mux.ts` extension. See ADR-0007 for the full schema migration and ADR-0009 for the spawn protocol shape.
