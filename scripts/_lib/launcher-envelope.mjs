/**
 * launcher-envelope.mjs — typed wire format for the launcher control socket.
 *
 * All envelopes carry `v: 1`. Mismatched versions are dropped by the receiver
 * with a stderr log; no other error handling is applied.
 *
 * Envelope kinds (launcher → peer):
 *   - focus-changed: launcher tells peers which peer is now focused.
 *   - signal: generic control signal.
 *   - tail-toggle: launcher tells a peer to start/stop bus-tail emission.
 *   - mesh-rail-update: launcher broadcasts a renderable snapshot of peer states and decisions
 *       count so every connected peer's mesh-rail widget can update in real time.
 *
 * Envelope kinds (peer → launcher):
 *   - focus-request: peer asks the launcher to focus a target peer.
 *   - heartbeat: peer announces it is alive.
 *   - tail-event: peer forwards a bus envelope for the launcher's tail overlay.
 *   - decision-pending: Top Supervisor peer signals an open/resolved local escalation dialog.
 *   - pin-request: peer promotes the currently-open ctx.ui.confirm dialog into the launcher queue.
 *   - pinned-resolved: launcher notifies the source peer that a pinned item was resolved.
 *   - decisions-jump: peer requests focus into the launcher's decisions-queue panel.
 *
 * All fields are plain strings / booleans — no complex sub-objects — so
 * JSON.parse + JSON.stringify is sufficient for encoding/decoding.
 */

import { randomUUID } from "node:crypto";

/**
 * @typedef {"focus-changed" | "signal" | "focus-request" | "heartbeat" | "tail-event" | "tail-toggle" | "decision-pending" | "pin-request" | "pinned-resolved" | "decisions-jump" | "mesh-rail-update"} EnvelopeKind
 */

/**
 * @typedef {{
 *   name: string;
 *   state: string;
 *   decisionPending: boolean;
 * }} MeshRailPeer
 */

/**
 * @typedef {{
 *   v: 1;
 *   id: string;
 *   kind: EnvelopeKind;
 *   ts: number;
 *   [key: string]: unknown;
 * }} LauncherEnvelope
 */

/**
 * Create a `focus-changed` envelope (launcher → all peers).
 *
 * @param {{ focused: string | null }} args
 * @returns {LauncherEnvelope}
 */
export function makeFocusChangedEnvelope(args) {
  return {
    v: 1,
    id: randomUUID(),
    kind: "focus-changed",
    ts: Date.now(),
    focused: args.focused,
  };
}

/**
 * Create a `focus-request` envelope (peer → launcher).
 *
 * @param {{ from: string; target: string }} args
 * @returns {LauncherEnvelope}
 */
export function makeFocusRequestEnvelope(args) {
  return {
    v: 1,
    id: randomUUID(),
    kind: "focus-request",
    ts: Date.now(),
    from: args.from,
    target: args.target,
  };
}

/**
 * Create a `signal` envelope (launcher → peer).
 *
 * @param {{ signal: string; data?: unknown }} args
 * @returns {LauncherEnvelope}
 */
export function makeSignalEnvelope(args) {
  const env = {
    v: 1,
    id: randomUUID(),
    kind: "signal",
    ts: Date.now(),
    signal: args.signal,
  };
  if (args.data !== undefined) env.data = args.data;
  return env;
}

/**
 * Create a `heartbeat` envelope (peer → launcher).
 *
 * @param {{ from: string }} args
 * @returns {LauncherEnvelope}
 */
export function makeHeartbeatEnvelope(args) {
  return {
    v: 1,
    id: randomUUID(),
    kind: "heartbeat",
    ts: Date.now(),
    from: args.from,
  };
}

/**
 * Create a `tail-toggle` envelope (launcher → peer).
 *
 * Tells the focused peer to start (`on: true`) or stop (`on: false`)
 * forwarding bus envelopes to the launcher as `tail-event` envelopes.
 * An optional `filter` restricts which envelope kinds are forwarded.
 *
 * @param {{ on: boolean; filter?: string }} args
 * @returns {LauncherEnvelope}
 */
export function makeTailToggleEnvelope(args) {
  const env = {
    v: 1,
    id: randomUUID(),
    kind: "tail-toggle",
    ts: Date.now(),
    on: args.on,
  };
  if (args.filter !== undefined) env.filter = args.filter;
  return env;
}

/**
 * Create a `tail-event` envelope (peer → launcher).
 *
 * Forwards a single bus envelope observation to the launcher for display
 * in the bus-tail overlay.
 *
 * @param {{
 *   from: string;
 *   sender: string;
 *   recipient: string;
 *   envKind: string;
 *   body: string;
 * }} args
 * @returns {LauncherEnvelope}
 */
export function makeTailEventEnvelope(args) {
  return {
    v: 1,
    id: randomUUID(),
    kind: "tail-event",
    ts: Date.now(),
    from: args.from,
    sender: args.sender,
    recipient: args.recipient,
    envKind: args.envKind,
    body: args.body,
  };
}

/**
 * Create a `decision-pending` envelope (peer → launcher).
 *
 * Emitted by the Top Supervisor peer when it opens (`on: true`) or resolves
 * (`on: false`) a local escalation dialog. The launcher uses this to show a
 * "decisions pending" badge for the peer when the human is focused elsewhere.
 *
 * @param {{ peer: string; on: boolean }} args
 * @returns {LauncherEnvelope}
 */
export function makeDecisionPendingEnvelope(args) {
  return {
    v: 1,
    id: randomUUID(),
    kind: "decision-pending",
    ts: Date.now(),
    peer: args.peer,
    on: args.on,
  };
}

/**
 * Create a `pin-request` envelope (peer → launcher).
 *
 * Emitted by a peer's /pin slash command to promote the currently-open
 * ctx.ui.confirm dialog into the launcher's persistent decisions queue.
 * The pinned item survives focus changes (sticky lifecycle).
 *
 * @param {{ msg_id: string; peer: string; kind: string; summary: string }} args
 * @returns {LauncherEnvelope}
 */
export function makePinRequestEnvelope(args) {
  return {
    v: 1,
    id: randomUUID(),
    kind: "pin-request",
    ts: Date.now(),
    msg_id: args.msg_id,
    peer: args.peer,
    kind_of_decision: args.kind,
    summary: args.summary,
  };
}

/**
 * Create a `pinned-resolved` envelope (launcher → peer).
 *
 * Emitted by the launcher after a human resolves a pinned item in the
 * decisions-queue panel. Carries the same wire shape as the inline
 * approval-result / revision-requested so the source peer's supervisor
 * inbound rail can route it normally.
 *
 * @param {{ msg_id: string; action: "approve" | "reject" | "revise"; note?: string }} args
 * @returns {LauncherEnvelope}
 */
export function makePinnedResolvedEnvelope(args) {
  const env = {
    v: 1,
    id: randomUUID(),
    kind: "pinned-resolved",
    ts: Date.now(),
    msg_id: args.msg_id,
    action: args.action,
  };
  if (args.note !== undefined) env.note = args.note;
  return env;
}

/**
 * Create a `decisions-jump` envelope (peer → launcher).
 *
 * Emitted by a peer's /decisions slash command to request that the launcher
 * focus into the decisions-queue panel for arrow-key navigation.
 *
 * @param {{ from: string }} args
 * @returns {LauncherEnvelope}
 */
export function makeDecisionsJumpEnvelope(args) {
  return {
    v: 1,
    id: randomUUID(),
    kind: "decisions-jump",
    ts: Date.now(),
    from: args.from,
  };
}

/**
 * Create a `mesh-rail-update` envelope (launcher → all peers).
 *
 * Carries a renderable snapshot of the current peer states and the launcher's
 * decisions-queue count. Broadcast on every state-mutating event so the
 * mesh-rail widget stays current in real time.
 *
 * @param {{ peers: Array<{name: string, state: string, decisionPending: boolean}>, decisionCount: number }} args
 * @returns {LauncherEnvelope}
 */
export function makeMeshRailUpdateEnvelope(args) {
  return {
    v: 1,
    id: randomUUID(),
    kind: "mesh-rail-update",
    ts: Date.now(),
    peers: args.peers,
    decisionCount: args.decisionCount,
  };
}

/**
 * Encode an envelope to a newline-terminated JSON string for wire transport.
 *
 * @param {LauncherEnvelope} env
 * @returns {string}
 */
export function encodeEnvelope(env) {
  return `${JSON.stringify(env)}\n`;
}

/**
 * Attempt to decode a raw JSON line. Returns null if:
 *   - not valid JSON
 *   - missing required fields
 *   - version mismatch (v !== 1) — caller should log and drop
 *
 * @param {string} line
 * @returns {{ env: LauncherEnvelope; versionMismatch: false } | { env: null; versionMismatch: boolean }}
 */
export function tryDecodeEnvelope(line) {
  let raw;
  try {
    raw = JSON.parse(line.trim());
  } catch {
    return { env: null, versionMismatch: false };
  }
  if (!raw || typeof raw !== "object") return { env: null, versionMismatch: false };
  if (raw.v !== 1) return { env: null, versionMismatch: true };
  if (typeof raw.id !== "string") return { env: null, versionMismatch: false };
  if (typeof raw.kind !== "string") return { env: null, versionMismatch: false };
  if (typeof raw.ts !== "number") return { env: null, versionMismatch: false };
  return { env: raw, versionMismatch: false };
}
