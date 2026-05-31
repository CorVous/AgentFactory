/**
 * launcher-envelope.d.mts — TypeScript declarations for launcher-envelope.mjs
 */

export type EnvelopeKind =
  | "focus-changed"
  | "signal"
  | "focus-request"
  | "heartbeat"
  | "tail-event"
  | "tail-toggle"
  | "decision-pending"
  | "pin-request"
  | "pinned-resolved"
  | "decisions-jump"
  | "mesh-rail-update"
  | "spawn-request"
  | "spawn-result"
  | "kill-request";

export interface MeshRailPeer {
  name: string;
  state: string;
  decisionPending: boolean;
}

export interface LauncherEnvelope {
  v: 1;
  id: string;
  kind: EnvelopeKind;
  ts: number;
  msg_id?: string;
  [key: string]: unknown;
}

/** Create a `focus-changed` envelope (launcher → all peers). */
export function makeFocusChangedEnvelope(args: {
  focused: string | null;
}): LauncherEnvelope;

/** Create a `focus-request` envelope (peer → launcher). */
export function makeFocusRequestEnvelope(args: {
  from: string;
  target: string;
}): LauncherEnvelope;

/** Create a `signal` envelope (launcher → peer). */
export function makeSignalEnvelope(args: {
  signal: string;
  data?: unknown;
}): LauncherEnvelope;

/** Create a `heartbeat` envelope (peer → launcher). */
export function makeHeartbeatEnvelope(args: { from: string }): LauncherEnvelope;

/** Create a `tail-toggle` envelope (launcher → peer). */
export function makeTailToggleEnvelope(args: {
  on: boolean;
  filter?: string;
}): LauncherEnvelope;

/** Create a `tail-event` envelope (peer → launcher). */
export function makeTailEventEnvelope(args: {
  from: string;
  sender: string;
  recipient: string;
  envKind: string;
  body: string;
}): LauncherEnvelope;

/** Create a `decision-pending` envelope (peer → launcher). */
export function makeDecisionPendingEnvelope(args: {
  peer: string;
  on: boolean;
}): LauncherEnvelope;

/** Create a `pin-request` envelope (peer → launcher). */
export function makePinRequestEnvelope(args: {
  msg_id: string;
  peer: string;
  kind: string;
  summary: string;
}): LauncherEnvelope;

/** Create a `pinned-resolved` envelope (launcher → peer). */
export function makePinnedResolvedEnvelope(args: {
  msg_id: string;
  action: "approve" | "reject" | "revise";
  note?: string;
}): LauncherEnvelope;

/** Create a `decisions-jump` envelope (peer → launcher). */
export function makeDecisionsJumpEnvelope(args: { from: string }): LauncherEnvelope;

/** Create a `mesh-rail-update` envelope (launcher → all peers). */
export function makeMeshRailUpdateEnvelope(args: {
  peers: Array<{ name: string; state: string; decisionPending: boolean }>;
  decisionCount: number;
  decisions?: Array<{
    msg_id: string;
    peer: string;
    kind: string;
    summary: string;
    pinned: boolean;
  }>;
}): LauncherEnvelope;

/** Create a `spawn-request` envelope (worker → host). */
export function makeSpawnRequestEnvelope(args: {
  msg_id: string;
  from: string;
  recipe: string;
  name?: string;
  groups?: string[];
  escalatesTo?: string;
  submitsWorkTo?: string;
  messagesWith?: string[];
  acceptsWorkFrom?: string[];
  task?: string;
  workspace?: { include: string[] };
}): LauncherEnvelope;

/** Create a `spawn-result` envelope (host → worker). */
export function makeSpawnResultEnvelope(args: {
  msg_id: string;
  in_reply_to: string;
  ok: boolean;
  name?: string;
  error?: string;
}): LauncherEnvelope;

/** Create a `kill-request` envelope (worker → host). */
export function makeKillRequestEnvelope(args: {
  msg_id: string;
  from: string;
  target: string;
}): LauncherEnvelope;

/** Encode an envelope to a newline-terminated JSON string. */
export function encodeEnvelope(env: LauncherEnvelope): string;

/** Attempt to decode a raw JSON line. Returns null for invalid/mismatched envelopes. */
export function tryDecodeEnvelope(
  line: string,
):
  | { env: LauncherEnvelope; versionMismatch: false }
  | { env: null; versionMismatch: boolean };
