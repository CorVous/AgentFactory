# Supervisor's LLM is in the review loop via `respond_to_request`

Inbound `submission` and `approval-request` envelopes reach the supervisor's LLM as deliberate review prompts; the supervisor decides via a single tool — `respond_to_request({msg_id, action, note?})` — with four actions: **approve** (rail applies artifacts to canonical), **reject** (rail discards), **revise** (rail asks the worker to redo with feedback; thread preserved; worker keeps its in-memory queue), and **escalate** (rail forwards the envelope to *this* supervisor's own supervisor and relays the result back).

## Why

- **The trust split is the whole point of artifact-bearing submission.** Workers compute in scratch, supervisors apply to canonical. A rail that auto-routes (no LLM) reduces the supervisor to a router and undoes the split — every submission would just need rubber-stamping. The LLM in the loop makes the supervisor a real review participant: it can read the artifact, reject misbehaviour, request a revision with feedback, or escalate to higher authority.
- **Escalation becomes deliberate, not a fallback.** The previous `--rpc-sock` model used "no UI" as the trigger to forward upward. In the new model UI presence is orthogonal — every supervisor (UI or not) reaches its LLM, which *chooses* to escalate. A peer running headless in `--mode rpc` still has a model and tools; the chain bottoms out at whoever decides to render rather than at whoever happens to have a terminal attached.
- **Revise preserves the cycle.** A "reject + send-feedback" pattern would close the original `msg_id`, lose the thread, conflate "abandon this work" with "redo this work," and may have lost the worker's staged artifacts. `revise` keeps the queue intact, the model continues its session, and the next submission's `in_reply_to` links back to the original thread for trace and audit.

## Considered alternatives

- **Rail-only auto-routing (no LLM in the loop).** Rejected: collapses the trust split — the supervisor becomes a router with no review power, and artifact-bearing submission ((ii)) collapses back to authorisation-only ((i)).
- **Hybrid: rail auto-handles known classes, LLM handles ambiguous ones.** Premature for v1. The classifier extension that decides "auto vs surface" can layer on top of the LLM-in-loop rail later, when there's a real workflow that wants it.
- **Use `reject + agent_send` to express revisions.** Rejected: loses the thread, conflates intent, may strand the worker without its in-memory artifacts.

## Consequences

- Every supervisor pays a model turn per inbound submission. Tier choice (`LEAD_HARE_MODEL` vs `TASK_RABBIT_MODEL`) matters when a supervisor handles many submissions; supervisors meant to be cheap routers should pick a small model and constrain their prompts.
- `requestHumanApproval`'s "no UI → forward to parent" fallback collapses. UI presence is no longer a trigger; the rail at the top of the escalation chain (typically a `human-relay` peer) is the only place a human dialog renders, and only if the chain decided to escalate that far.
- A loop guardrail caps revisions per thread (initial: 3 rounds); on cap, the rail forces a final approve / reject from the supervisor on the next round.
- Mid-revision escalation forwards the *whole* chain (original submission + revision notes + re-submissions) to the higher-up supervisor as a single payload so context isn't lost across hops.
