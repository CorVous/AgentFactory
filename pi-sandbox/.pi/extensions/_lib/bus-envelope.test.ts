import { describe, expect, it } from "vitest";
import {
  encodeEnvelope,
  makeMessageEnvelope,
  renderInboundForUser,
  tryDecodeEnvelope,
  type Envelope,
} from "./bus-envelope";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("makeMessageEnvelope", () => {
  it("produces a v:2 message envelope with a fresh UUID and current ts", () => {
    const before = Date.now();
    const env = makeMessageEnvelope({ from: "planner", to: "worker-a", text: "hello" });
    const after = Date.now();

    expect(env.v).toBe(2);
    expect(env.msg_id).toMatch(UUID_RE);
    expect(env.from).toBe("planner");
    expect(env.to).toBe("worker-a");
    expect(env.ts).toBeGreaterThanOrEqual(before);
    expect(env.ts).toBeLessThanOrEqual(after);
    expect(env.payload).toEqual({ kind: "message", text: "hello" });
    expect(env.in_reply_to).toBeUndefined();
  });

  it("carries in_reply_to when supplied", () => {
    const env = makeMessageEnvelope({
      from: "worker-a",
      to: "planner",
      text: "pong",
      in_reply_to: "abc12345-0000-0000-0000-000000000000",
    });
    expect(env.in_reply_to).toBe("abc12345-0000-0000-0000-000000000000");
  });

  it("omits in_reply_to from JSON when not supplied", () => {
    const env = makeMessageEnvelope({ from: "a", to: "b", text: "x" });
    const json = JSON.parse(encodeEnvelope(env));
    expect("in_reply_to" in json).toBe(false);
  });
});

describe("encodeEnvelope", () => {
  it("produces a single line ending in newline", () => {
    const env = makeMessageEnvelope({ from: "a", to: "b", text: "hi" });
    const wire = encodeEnvelope(env);
    expect(wire.endsWith("\n")).toBe(true);
    expect(wire.slice(0, -1).includes("\n")).toBe(false);
  });

  it("round-trips through tryDecodeEnvelope", () => {
    const env = makeMessageEnvelope({
      from: "planner",
      to: "worker-a",
      text: "hello\tworld",
      in_reply_to: "abc12345-0000-0000-0000-000000000000",
    });
    const decoded = tryDecodeEnvelope(encodeEnvelope(env));
    expect(decoded).toEqual(env);
  });
});

describe("tryDecodeEnvelope", () => {
  const valid: Envelope = {
    v: 2,
    msg_id: "abc12345-0000-0000-0000-000000000000",
    from: "a",
    to: "b",
    ts: 1700000000000,
    payload: { kind: "message", text: "hi" },
  };

  it("returns null for non-JSON input", () => {
    expect(tryDecodeEnvelope("not json")).toBeNull();
  });

  it("returns null for v:1 envelopes", () => {
    expect(tryDecodeEnvelope(JSON.stringify({ ...valid, v: 1 }))).toBeNull();
  });

  it("returns null for v:3 envelopes", () => {
    expect(tryDecodeEnvelope(JSON.stringify({ ...valid, v: 3 }))).toBeNull();
  });

  it("returns null when payload is missing", () => {
    const { payload: _, ...rest } = valid;
    expect(tryDecodeEnvelope(JSON.stringify(rest))).toBeNull();
  });

  it("returns null for unknown payload kind", () => {
    expect(
      tryDecodeEnvelope(JSON.stringify({ ...valid, payload: { kind: "submission", text: "x" } })),
    ).toBeNull();
  });

  it("returns null when from is missing", () => {
    const { from: _, ...rest } = valid;
    expect(tryDecodeEnvelope(JSON.stringify(rest))).toBeNull();
  });

  it("returns null when msg_id is missing", () => {
    const { msg_id: _, ...rest } = valid;
    expect(tryDecodeEnvelope(JSON.stringify(rest))).toBeNull();
  });

  it("returns null when to is missing", () => {
    const { to: _, ...rest } = valid;
    expect(tryDecodeEnvelope(JSON.stringify(rest))).toBeNull();
  });

  it("returns null when ts is missing", () => {
    const { ts: _, ...rest } = valid;
    expect(tryDecodeEnvelope(JSON.stringify(rest))).toBeNull();
  });

  it("returns null when payload.text is not a string", () => {
    expect(
      tryDecodeEnvelope(JSON.stringify({ ...valid, payload: { kind: "message", text: 42 } })),
    ).toBeNull();
  });

  it("returns null when ts is not a number", () => {
    expect(tryDecodeEnvelope(JSON.stringify({ ...valid, ts: "now" }))).toBeNull();
  });

  it("accepts a well-formed v:2 message envelope", () => {
    expect(tryDecodeEnvelope(JSON.stringify(valid))).toEqual(valid);
  });
});

describe("renderInboundForUser", () => {
  it("formats without in_reply_to", () => {
    const env: Envelope = {
      v: 2,
      msg_id: "abc12345-0000-0000-0000-000000000000",
      from: "planner",
      to: "worker-a",
      ts: 0,
      payload: { kind: "message", text: "ping" },
    };
    expect(renderInboundForUser(env)).toBe("[from planner] ping");
  });

  it("formats with in_reply_to using an 8-char prefix", () => {
    const env: Envelope = {
      v: 2,
      msg_id: "def67890-0000-0000-0000-000000000000",
      from: "worker-a",
      to: "planner",
      ts: 0,
      payload: { kind: "message", text: "pong" },
      in_reply_to: "abc12345-0000-0000-0000-000000000000",
    };
    expect(renderInboundForUser(env)).toBe("[from worker-a re:abc12345] pong");
  });
});
