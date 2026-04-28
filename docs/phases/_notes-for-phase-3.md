# Notes for Phase 3 plan

Scratch file — a place to stash forward-looking observations from earlier phases that Phase 3's planner needs to see. Delete this file when Phase 3 plan is written (its contents fold into the plan's "Inherited state" / "Required reading" / "Out of scope" sections as appropriate).

This file is **not a plan**. It's a memo for the plan author.

---

## What's already done re: `deferred-confirm`

Phase 2 + a follow-up cleanup commit (PR #54) slimmed `deferred-confirm.ts` along with the seven other rails: it now reads `rpcSock` from `getHabitat()` via the same try/catch pattern as `sandbox.ts` and friends. The `--rpc-sock` pi flag is gone. `requestHumanApproval`'s logic — UI → rpc-sock → loud-fail — is unchanged in shape, just sourcing differently.

Phase 3 therefore inherits a `deferred-confirm` that is already Habitat-aware. When Phase 3 builds the supervisor inbound rail and `respond_to_request` tool, it can:

- Move `requestHumanApproval` and the `rpcRequestApproval` helper out of `deferred-confirm.ts` into the new shared module that owns the inbound/outbound envelope handling. `deferred-confirm` becomes a *user* of that module, not the owner of the escalation primitive (which it accidentally became in main; see ADR-0001's "homeless primitive" framing).
- Drop `Habitat.rpcSock` once the bus has subsumed approval forwarding (escalation goes via `agent_call({to: supervisor, kind: "approval-request"})` instead of via the per-call Unix socket). At that point `--rpc-sock` and `agent-spawn`'s per-call sockets disappear together — but that's late-Phase-3 / Phase-5, not the opening move.

What Phase 3 does **not** need to do: re-slim `deferred-confirm` (already done), introduce a `getHabitat().rpcSock` read anywhere new (existing readers cover the use cases), or untangle the deferred-confirm-as-escalation-primitive mixup (Phase 3's new shared module is what untangles it).

## `agent_call`'s silent-empty-string for non-message replies

Phase 1 spot-check observation. In `agent-bus.ts`'s `handleIncoming`:

```ts
if (env.in_reply_to) {
  const pending = state.pendingCalls.get(env.in_reply_to);
  if (pending) {
    clearTimeout(pending.timer);
    state.pendingCalls.delete(env.in_reply_to);
    pending.resolve(env.payload.kind === "message" ? env.payload.text : "");
    return;
  }
}
```

The `env.payload.kind === "message" ? env.payload.text : ""` branch was forward-compat for Phase 3+ when new payload kinds arrive. **Phase 3 will hit this:** when an `approval-result` or `submission` envelope arrives as a reply to a pending `agent_call`, this code silently resolves with `""`.

Phase 3 needs to decide:

- **(a)** Reject the pending promise with a typed-mismatch error: *"agent_call expected a message-kind reply, got submission"*. Forces callers to know what kind of reply they expect (which they typically do at the call site).
- **(b)** Extend `agent_call` to accept and return typed replies: e.g., `agent_call` resolves with the whole `Payload` object, callers destructure on `kind`. More disciplined; bigger API change.
- **(c)** Add a separate `agent_call_typed({to, body, expect_kind})` that returns the typed payload, leaving `agent_call` as the message-only convenience.

Recommendation: **(a)** for v1. Lowest API churn. The supervisor-handler pattern Phase 3 is building doesn't *use* `agent_call` for approval/submission round-trips anyway — those flow through the dedicated inbound rail. So `agent_call` stays a message-only convenience, and a non-message reply is simply a programming error worth surfacing loudly.

## Stale comments in `agent-bus.ts` deferred to Phase 5

The file-header comment block in `agent-bus.ts` calls itself a "Companion to agent-spawn (blocking delegation). The two are orthogonal." That sentence becomes wrong only when `agent-spawn` is deleted (Phase 5). Phase 3 should leave the comment alone; Phase 5's `agent-spawn`-deletion commit updates it.

## Dead env-var fallback in `agent-status-reporter.ts`

After Phase 2, the env-var fallback (`PI_RPC_SOCK`, `PI_AGENT_NAME`) is unreachable because the runner no longer sets those vars. The Phase 2 spot-check explicitly chose to leave it for uniformity with the try/catch pattern in other rails. Phase 3 doesn't need to touch this. It tidies naturally when Phase 5 deletes `agent-spawn` (which is what made `PI_AGENT_DELEGATION_ID` exist) — at that point the whole try/catch block can be removed.
