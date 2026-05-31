// _lib/intercept.ts — pure routing logic for the intercept extension.
//
// Determines whether an inbound envelope should be routed to the human
// (via ctx.ui.confirm) or fall through to the LLM (via respond_to_request).
//
// Rules:
//   - "message"-kind envelopes are ALWAYS "llm" (unrestricted free-flow chat).
//   - "approval-request" and "submission" envelopes: "human" when focused,
//     "llm" when not focused.
//   - All other payload kinds: "llm" (passthrough; not handled by this rail).
//
// No ctx.ui calls here — this module is hermetic. The extension layer
// (intercept.ts) does the actual ctx.ui.confirm invocation.

export type InterceptRoute = "human" | "llm";

export type EnvelopeKind =
  | "message"
  | "approval-request"
  | "approval-result"
  | "revision-requested"
  | "submission"
  | string; // forward-compat

/**
 * Decide whether this envelope should be routed to the human or the LLM.
 *
 * @param kind    - The payload.kind of the inbound envelope.
 * @param focused - Whether this peer is currently the focused peer in the launcher.
 * @returns "human" | "llm"
 */
export function routeEnvelope(kind: EnvelopeKind, focused: boolean): InterceptRoute {
  // "message" kind is always free-flow; never intercepted by the human.
  if (kind === "message") return "llm";

  // Only approval-request and submission can be intercepted.
  if (kind === "approval-request" || kind === "submission") {
    return focused ? "human" : "llm";
  }

  // All other kinds (approval-result, revision-requested, etc.) pass through.
  return "llm";
}

/**
 * True when this peer is the Top Supervisor — i.e. no supervisor is configured
 * above it in the topology. When true, the "escalate" action must be disabled.
 *
 * @param supervisorName - Value from getHabitat().supervisor (may be undefined).
 */
export function isTopSupervisor(supervisorName: string | undefined): boolean {
  return !supervisorName || supervisorName.trim() === "";
}

/**
 * Returns true when the supervisor inbound rail is active on this peer —
 * i.e. `acceptedFrom` is non-empty, indicating this peer can receive typed
 * inbound envelopes from other peers.
 *
 * Used by the intercept extension to determine whether to wire itself.
 * A peer with an empty `acceptedFrom` list has no supervisor inbound rail,
 * and intercept is a silent no-op on such peers.
 *
 * @param acceptedFrom - Value from getHabitat().acceptedFrom.
 */
export function hasSupervisorInboundRail(acceptedFrom: string[]): boolean {
  return Array.isArray(acceptedFrom) && acceptedFrom.length > 0;
}

// ---------------------------------------------------------------------------
// Intercept batch-collect helpers (Slice 6: composite-submission batching)
// ---------------------------------------------------------------------------

/**
 * Minimal envelope shape required for batch-collect decisions.
 * The intercept batch helpers only care about the kind and focus, not
 * the full envelope structure.
 */
export interface BatchEnvelope {
  kind: EnvelopeKind;
}

/**
 * InterceptBatch holds envelopes destined for the human that arrived during
 * a turn (when focused=true). The extension layer calls `collectForBatch` for
 * each intercepted envelope and `flushBatch` at turn_end to open one dialog
 * over the whole batch.
 *
 * Pure bookkeeping only — no ctx.ui calls here.
 */
export interface InterceptBatch<T extends BatchEnvelope> {
  /** Add an envelope to the batch. Only call when the route is "human". */
  collect(env: T): void;
  /** Returns the current batch contents without clearing. */
  peek(): T[];
  /**
   * Flush and return the batch, clearing it. If the batch is empty, returns [].
   * The extension layer opens a dialog for each returned envelope.
   */
  flush(): T[];
  /** Current batch size. */
  size(): number;
}

/**
 * Create a fresh intercept batch collector.
 * @returns A stateful collector whose `flush()` drains the queue.
 */
export function createInterceptBatch<T extends BatchEnvelope>(): InterceptBatch<T> {
  const queue: T[] = [];
  return {
    collect(env: T) { queue.push(env); },
    peek() { return queue.slice(); },
    flush() { return queue.splice(0); },
    size() { return queue.length; },
  };
}

/**
 * Decide whether an envelope should be added to the intercept batch
 * (focused human path) or passed through to the LLM path.
 *
 * A "collect" result means: add to batch and do NOT call the LLM path yet.
 * A "passthrough" result means: let the LLM path handle it immediately.
 *
 * This is a pure decision function; actual batching is done by the caller.
 *
 * @param kind    - Payload kind of the envelope.
 * @param focused - Whether this peer is the focused peer in the launcher.
 * @returns "collect" | "passthrough"
 */
export function batchDecision(kind: EnvelopeKind, focused: boolean): "collect" | "passthrough" {
  const route = routeEnvelope(kind, focused);
  return route === "human" ? "collect" : "passthrough";
}
