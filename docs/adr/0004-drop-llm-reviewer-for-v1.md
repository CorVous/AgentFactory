# Drop LLM reviewer for V1; human-relay handles QA

V1 of the Ralph-Loop mesh routes **Foreman** submissions directly to a human via `human-relay.mjs`, bypassing the supervisor LLM described in [ADR-0003](./0003-supervisor-llm-in-review-loop.md). The supervisor extension stays loaded but inert; only the human ever calls `respond_to_request`. This is a deliberate deferral, not abandonment — ADR-0003 remains the future-state for hybrid-mode and tiered review.

## Why

- **Pocock's reference flow is "Ralph Loop → Manual QA."** The published workflow that V1 mimics has no LLM reviewer between worker and human; introducing one before the **Foreman** side works adds a reviewer-prompt design problem on top of the Foreman design problem. V1 is intentionally the smaller surface.
- **The trust split is preserved by the worktree boundary.** ADR-0003's motivation was the trust split (workers compute scratch, supervisors apply canonical). With branch-as-**Submission**, the trust split still exists — the Foreman commits to a branch, the apply step is a human merge — but the *reviewer* of that merge is the human in the human-relay UI, not an LLM.
- **Tier choice for review is moot in V1.** Without an LLM reviewer there is no "supervisors run `LEAD_HARE_MODEL` because they review many submissions" decision to make. Tier choice in V1 is purely "which tier runs the Foreman."
- **Smaller surface to debug.** One less LLM context to engineer; one less revision cycle to test; one less escalation chain to trace. V1 ships when the **Foreman** ships.

## Considered alternatives

- **Keep ADR-0003 in V1.** Rejected for V1: requires designing the supervisor LLM's review prompt against branch payloads (different shape from artifact lists), engineering its tool palette (read diff, run tests, read the issue file), and tuning its tier choice — all before the Foreman side has shipped. Re-considered for V2.
- **Hybrid: LLM auto-approves "tests pass + diff < N lines + no new deps."** Rejected for V1: needs a classifier extension and signals worth trusting. Premature without observed traffic.
- **Drop ADR-0003 entirely.** Rejected: the trust split it motivates is real and survives branch-mode. The LLM-in-loop is just not needed *yet*.

## Consequences

- `pi-sandbox/.pi/extensions/supervisor.ts` remains loaded for any peer with `acceptedFrom` / `supervisor` / `submitTo` set, but in V1 only `human-relay` ever exercises the action graph (approve / reject / revise / escalate).
- `_lib/supervisor-inbox.ts` is unchanged. The action-graph code (revision cap, escalation forwarding, the four-action surface) is the same; only the consumer changes.
- `respond_to_request` stays as the protocol. A V2 hybrid-mode classifier extension can add an auto-approve decision before falling through to human-relay without changing the wire format.
- ADR-0003's revision cap (3 rounds) still applies — but the human is the one bouncing off it. Future hybrid-mode preserves the cap unchanged.
- Tier choice for V1 collapses to a single decision: which tier runs the Foreman.
- The Foreman's `submitTo` field points at `human-relay` for V1 Ralph recipes; ADR-0005 covers the Foreman recipe shape in detail.
