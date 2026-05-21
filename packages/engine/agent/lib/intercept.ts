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
