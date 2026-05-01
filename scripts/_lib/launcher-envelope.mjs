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
 *
 * Envelope kinds (peer → launcher):
 *   - focus-request: peer asks the launcher to focus a target peer.
 *   - heartbeat: peer announces it is alive.
 *   - tail-event: peer forwards a bus envelope for the launcher's tail overlay.
 *   - decision-pending: Top Supervisor peer signals an open/resolved local escalation dialog.
 *
 * All fields are plain strings / booleans — no complex sub-objects — so
 * JSON.parse + JSON.stringify is sufficient for encoding/decoding.
 */

import { randomUUID } from "node:crypto";

/**
 * @typedef {"focus-changed" | "signal" | "focus-request" | "heartbeat" | "tail-event" | "tail-toggle" | "decision-pending"} EnvelopeKind
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
 * "decisions pending" badge next to the peer in the chrome when the human is
 * focused elsewhere.
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
