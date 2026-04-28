// Wire format for agent-bus envelopes. Versioned (`v: 2`) with a
// discriminated `payload` union so future phases can add new kinds
// (`submission`, `approval-request`, `approval-result`,
// `revision-requested`) without changing the transport. v:1 envelopes
// are not accepted — both ends update atomically.
//
// Used by both the TypeScript bus extension (agent-bus.ts) and any
// agent that talks the bus protocol. The plain-JS human-relay
// duplicates this shape inline; keep them in sync.

import { randomUUID } from "node:crypto";

export type Payload = { kind: "message"; text: string };

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

export function encodeEnvelope(env: Envelope): string {
  return `${JSON.stringify(env)}\n`;
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
  const payload = p as Record<string, unknown>;
  if (payload.kind !== "message") return null;
  if (typeof payload.text !== "string") return null;
  return o as unknown as Envelope;
}

export function renderInboundForUser(env: Envelope): string {
  const text = env.payload.kind === "message" ? env.payload.text : `(${env.payload.kind})`;
  const re = env.in_reply_to ? ` re:${env.in_reply_to.slice(0, 8)}` : "";
  return `[from ${env.from}${re}] ${text}`;
}
