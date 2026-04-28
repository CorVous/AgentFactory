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
