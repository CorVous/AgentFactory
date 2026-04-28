// Wire format for agent-bus envelopes. Versioned (`v: 2`) with a
// discriminated `payload` union. v:1 envelopes are not accepted —
// both ends update atomically.
//
// Used by both the TypeScript bus extension (agent-bus.ts) and any
// agent that talks the bus protocol. The plain-JS human-relay
// duplicates this shape inline; keep them in sync.

import { randomUUID } from "node:crypto";

export type Artifact =
  | { kind: "write"; relPath: string; content: string; sha256: string }
  | { kind: "edit"; relPath: string; sha256OfOriginal: string;
      edits: Array<{ oldString: string; newString: string }> }
  | { kind: "move"; src: string; dst: string; sha256OfSource: string }
  | { kind: "delete"; relPath: string; sha256: string };

export type Payload =
  | { kind: "message"; text: string }
  | { kind: "approval-request"; title: string; summary: string; preview: string }
  | { kind: "approval-result"; approved: boolean; note?: string }
  | { kind: "revision-requested"; note: string }
  | { kind: "submission"; artifacts: Artifact[]; summary?: string };

export interface Envelope {
  v: 2;
  msg_id: string;
  from: string;
  to: string;
  ts: number;
  payload: Payload;
  in_reply_to?: string;
}

export function makeMessageEnvelope(args: {
  from: string;
  to: string;
  text: string;
  in_reply_to?: string;
}): Envelope {
  const env: Envelope = {
    v: 2,
    msg_id: randomUUID(),
    from: args.from,
    to: args.to,
    ts: Date.now(),
    payload: { kind: "message", text: args.text },
  };
  if (args.in_reply_to !== undefined) env.in_reply_to = args.in_reply_to;
  return env;
}

export function makeApprovalRequestEnvelope(args: {
  from: string;
  to: string;
  title: string;
  summary: string;
  preview: string;
  in_reply_to?: string;
}): Envelope {
  const env: Envelope = {
    v: 2,
    msg_id: randomUUID(),
    from: args.from,
    to: args.to,
    ts: Date.now(),
    payload: { kind: "approval-request", title: args.title, summary: args.summary, preview: args.preview },
  };
  if (args.in_reply_to !== undefined) env.in_reply_to = args.in_reply_to;
  return env;
}

export function makeApprovalResultEnvelope(args: {
  from: string;
  to: string;
  in_reply_to: string;
  approved: boolean;
  note?: string;
}): Envelope {
  const payload: Payload = args.note !== undefined
    ? { kind: "approval-result", approved: args.approved, note: args.note }
    : { kind: "approval-result", approved: args.approved };
  const env: Envelope = {
    v: 2,
    msg_id: randomUUID(),
    from: args.from,
    to: args.to,
    ts: Date.now(),
    payload,
    in_reply_to: args.in_reply_to,
  };
  return env;
}

export function makeRevisionRequestedEnvelope(args: {
  from: string;
  to: string;
  in_reply_to: string;
  note: string;
}): Envelope {
  return {
    v: 2,
    msg_id: randomUUID(),
    from: args.from,
    to: args.to,
    ts: Date.now(),
    payload: { kind: "revision-requested", note: args.note },
    in_reply_to: args.in_reply_to,
  };
}

export function makeSubmissionEnvelope(args: {
  from: string;
  to: string;
  artifacts: Artifact[];
  summary?: string;
  in_reply_to?: string;
}): Envelope {
  const payload: Payload = args.summary !== undefined
    ? { kind: "submission", artifacts: args.artifacts, summary: args.summary }
    : { kind: "submission", artifacts: args.artifacts };
  const env: Envelope = {
    v: 2,
    msg_id: randomUUID(),
    from: args.from,
    to: args.to,
    ts: Date.now(),
    payload,
  };
  if (args.in_reply_to !== undefined) env.in_reply_to = args.in_reply_to;
  return env;
}

export function encodeEnvelope(env: Envelope): string {
  return `${JSON.stringify(env)}\n`;
}

function isValidArtifact(a: unknown): a is Artifact {
  if (!a || typeof a !== "object") return false;
  const art = a as Record<string, unknown>;
  switch (art.kind) {
    case "write":
      return typeof art.relPath === "string" && typeof art.content === "string" && typeof art.sha256 === "string";
    case "edit": {
      if (typeof art.relPath !== "string" || typeof art.sha256OfOriginal !== "string") return false;
      if (!Array.isArray(art.edits)) return false;
      return (art.edits as unknown[]).every(
        (e) => e && typeof e === "object" &&
          typeof (e as Record<string, unknown>).oldString === "string" &&
          typeof (e as Record<string, unknown>).newString === "string",
      );
    }
    case "move":
      return typeof art.src === "string" && typeof art.dst === "string" && typeof art.sha256OfSource === "string";
    case "delete":
      return typeof art.relPath === "string" && typeof art.sha256 === "string";
    default:
      return false;
  }
}

function isValidPayload(payload: Record<string, unknown>): boolean {
  switch (payload.kind) {
    case "message":
      return typeof payload.text === "string";
    case "approval-request":
      return typeof payload.title === "string" && typeof payload.summary === "string" && typeof payload.preview === "string";
    case "approval-result":
      if (typeof payload.approved !== "boolean") return false;
      if (payload.note !== undefined && typeof payload.note !== "string") return false;
      return true;
    case "revision-requested":
      return typeof payload.note === "string";
    case "submission": {
      if (!Array.isArray(payload.artifacts)) return false;
      if (!(payload.artifacts as unknown[]).every(isValidArtifact)) return false;
      if (payload.summary !== undefined && typeof payload.summary !== "string") return false;
      return true;
    }
    default:
      return false;
  }
}

export function tryDecodeEnvelope(line: string): Envelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 2) return null;
  if (typeof o.msg_id !== "string") return null;
  if (typeof o.from !== "string") return null;
  if (typeof o.to !== "string") return null;
  if (typeof o.ts !== "number") return null;
  if (o.in_reply_to !== undefined && typeof o.in_reply_to !== "string") return null;
  const p = o.payload;
  if (!p || typeof p !== "object") return null;
  if (!isValidPayload(p as Record<string, unknown>)) return null;
  return o as unknown as Envelope;
}

export function renderInboundForUser(env: Envelope): string {
  const p = env.payload;
  switch (p.kind) {
    case "message": {
      const re = env.in_reply_to ? ` re:${env.in_reply_to.slice(0, 8)}` : "";
      return `[from ${env.from}${re}] ${p.text}`;
    }
    case "approval-request":
      return `[approval request from ${env.from}] ${p.title}`;
    case "approval-result":
      return `[approval result from ${env.from}: ${p.approved ? "approved" : "rejected"}]`;
    case "revision-requested":
      return `[revise from ${env.from}] ${p.note}`;
    case "submission": {
      const n = p.artifacts.length;
      const label = n === 1 ? "1 artifact" : `${n} artifacts`;
      return p.summary !== undefined
        ? `[submission from ${env.from}] ${label}: ${p.summary}`
        : `[submission from ${env.from}] ${label}`;
    }
  }
}
