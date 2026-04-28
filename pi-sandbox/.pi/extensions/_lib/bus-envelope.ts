import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Artifact — carries one deferred filesystem operation inside a submission.
// ---------------------------------------------------------------------------

export type Artifact =
  | { kind: "write"; relPath: string; content: string; sha256: string }
  | { kind: "edit"; relPath: string; sha256OfOriginal: string; edits: Array<{ oldString: string; newString: string }> }
  | { kind: "move"; src: string; dst: string; sha256OfSource: string }
  | { kind: "delete"; relPath: string; sha256: string };

// ---------------------------------------------------------------------------
// Payload — discriminated union of all envelope kinds.
// ---------------------------------------------------------------------------

export type Payload =
  | { kind: "message"; text: string }
  | { kind: "approval-request"; title: string; summary: string; preview: string }
  | { kind: "approval-result"; approved: boolean; note?: string }
  | { kind: "revision-requested"; note: string }
  | { kind: "submission"; artifacts: Artifact[]; summary?: string };

// ---------------------------------------------------------------------------
// Envelope — the wire format.  v:2 marks the typed-payload era.
// ---------------------------------------------------------------------------

export interface Envelope {
  v: 2;
  msg_id: string;
  from: string;
  to: string;
  ts: number;
  payload: Payload;
  in_reply_to?: string;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

function base(from: string, to: string, payload: Payload, in_reply_to?: string): Envelope {
  const env: Envelope = { v: 2, msg_id: randomUUID(), from, to, ts: Date.now(), payload };
  if (in_reply_to !== undefined) env.in_reply_to = in_reply_to;
  return env;
}

export function makeMessageEnvelope(args: {
  from: string;
  to: string;
  text: string;
  in_reply_to?: string;
}): Envelope {
  return base(args.from, args.to, { kind: "message", text: args.text }, args.in_reply_to);
}

export function makeApprovalRequestEnvelope(args: {
  from: string;
  to: string;
  title: string;
  summary: string;
  preview: string;
  in_reply_to?: string;
}): Envelope {
  return base(
    args.from,
    args.to,
    { kind: "approval-request", title: args.title, summary: args.summary, preview: args.preview },
    args.in_reply_to,
  );
}

export function makeApprovalResultEnvelope(args: {
  from: string;
  to: string;
  in_reply_to: string;
  approved: boolean;
  note?: string;
}): Envelope {
  const payload: Extract<Payload, { kind: "approval-result" }> = { kind: "approval-result", approved: args.approved };
  if (args.note !== undefined) payload.note = args.note;
  return base(args.from, args.to, payload, args.in_reply_to);
}

export function makeRevisionRequestedEnvelope(args: {
  from: string;
  to: string;
  in_reply_to: string;
  note: string;
}): Envelope {
  return base(args.from, args.to, { kind: "revision-requested", note: args.note }, args.in_reply_to);
}

export function makeSubmissionEnvelope(args: {
  from: string;
  to: string;
  artifacts: Artifact[];
  summary?: string;
  in_reply_to?: string;
}): Envelope {
  const payload: Extract<Payload, { kind: "submission" }> = { kind: "submission", artifacts: args.artifacts };
  if (args.summary !== undefined) payload.summary = args.summary;
  return base(args.from, args.to, payload, args.in_reply_to);
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function encodeEnvelope(env: Envelope): string {
  return JSON.stringify(env) + "\n";
}

// ---------------------------------------------------------------------------
// Decoding + validation
// ---------------------------------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function validateArtifact(a: unknown): a is Artifact {
  if (typeof a !== "object" || a === null) return false;
  const obj = a as Record<string, unknown>;
  switch (obj.kind) {
    case "write":
      return isString(obj.relPath) && isString(obj.content) && isString(obj.sha256);
    case "edit":
      return isString(obj.relPath) && isString(obj.sha256OfOriginal) && Array.isArray(obj.edits);
    case "move":
      return isString(obj.src) && isString(obj.dst) && isString(obj.sha256OfSource);
    case "delete":
      return isString(obj.relPath) && isString(obj.sha256);
    default:
      return false;
  }
}

function validatePayload(p: unknown): p is Payload {
  if (typeof p !== "object" || p === null) return false;
  const obj = p as Record<string, unknown>;
  switch (obj.kind) {
    case "message":
      return isString(obj.text);
    case "approval-request":
      return isString(obj.title) && isString(obj.summary) && isString(obj.preview);
    case "approval-result":
      return typeof obj.approved === "boolean";
    case "revision-requested":
      return isString(obj.note);
    case "submission":
      return Array.isArray(obj.artifacts) && (obj.artifacts as unknown[]).every(validateArtifact);
    default:
      return false;
  }
}

export function tryDecodeEnvelope(line: string): Envelope | null {
  try {
    const parsed: unknown = JSON.parse(line.trim());
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.v !== 2) return null;
    if (!isString(obj.msg_id) || !isString(obj.from) || !isString(obj.to)) return null;
    if (typeof obj.ts !== "number") return null;
    if (!validatePayload(obj.payload)) return null;
    return parsed as Envelope;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderInboundForUser(env: Envelope): string {
  const replyTag = env.in_reply_to ? ` re:${env.in_reply_to.slice(0, 8)}` : "";
  const { payload } = env;
  switch (payload.kind) {
    case "message":
      return `[from ${env.from}${replyTag}] ${payload.text}`;
    case "approval-request":
      return `[approval request from ${env.from}] ${payload.title}`;
    case "approval-result":
      return `[approval result from ${env.from}: ${payload.approved ? "approved" : "rejected"}]`;
    case "revision-requested":
      return `[revise from ${env.from}] ${payload.note}`;
    case "submission": {
      const suffix = payload.summary !== undefined ? `: ${payload.summary}` : "";
      return `[submission from ${env.from}] ${payload.artifacts.length} artifacts${suffix}`;
    }
  }
}
