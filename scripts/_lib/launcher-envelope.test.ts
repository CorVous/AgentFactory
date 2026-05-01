/**
 * launcher-envelope.test.ts — hermetic unit tests for the launcher wire format.
 *
 * Contract: no I/O, no network, no env from models.env.
 */

import { describe, it, expect } from "vitest";
import {
  makeFocusChangedEnvelope,
  makeFocusRequestEnvelope,
  makeSignalEnvelope,
  makeHeartbeatEnvelope,
  makeTailToggleEnvelope,
  makeTailEventEnvelope,
  makeDecisionPendingEnvelope,
  makePinRequestEnvelope,
  makePinnedResolvedEnvelope,
  makeDecisionsJumpEnvelope,
  encodeEnvelope,
  tryDecodeEnvelope,
} from "./launcher-envelope.mjs";

describe("makeFocusChangedEnvelope", () => {
  it("produces a v:1 envelope with focused peer", () => {
    const env = makeFocusChangedEnvelope({ focused: "peer-a" });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("focus-changed");
    expect(env.focused).toBe("peer-a");
    expect(typeof env.id).toBe("string");
    expect(typeof env.ts).toBe("number");
  });

  it("supports focused: null", () => {
    const env = makeFocusChangedEnvelope({ focused: null });
    expect(env.focused).toBeNull();
  });
});

describe("makeFocusRequestEnvelope", () => {
  it("produces a v:1 focus-request with from and target", () => {
    const env = makeFocusRequestEnvelope({ from: "peer-a", target: "peer-b" });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("focus-request");
    expect(env.from).toBe("peer-a");
    expect(env.target).toBe("peer-b");
  });
});

describe("makeSignalEnvelope", () => {
  it("produces a signal envelope without data", () => {
    const env = makeSignalEnvelope({ signal: "reload" });
    expect(env.kind).toBe("signal");
    expect(env.signal).toBe("reload");
    expect("data" in env).toBe(false);
  });

  it("includes data when provided", () => {
    const env = makeSignalEnvelope({ signal: "test", data: { x: 1 } });
    expect(env.data).toEqual({ x: 1 });
  });
});

describe("makeHeartbeatEnvelope", () => {
  it("produces a heartbeat from the given peer", () => {
    const env = makeHeartbeatEnvelope({ from: "peer-a" });
    expect(env.kind).toBe("heartbeat");
    expect(env.from).toBe("peer-a");
  });
});

describe("makeTailToggleEnvelope", () => {
  it("produces a tail-toggle envelope with on:true", () => {
    const env = makeTailToggleEnvelope({ on: true });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("tail-toggle");
    expect(env.on).toBe(true);
    expect("filter" in env).toBe(false);
    expect(typeof env.id).toBe("string");
    expect(typeof env.ts).toBe("number");
  });

  it("produces a tail-toggle envelope with on:false", () => {
    const env = makeTailToggleEnvelope({ on: false });
    expect(env.on).toBe(false);
  });

  it("includes filter when provided", () => {
    const env = makeTailToggleEnvelope({ on: true, filter: "message" });
    expect(env.filter).toBe("message");
  });

  it("omits filter when not provided", () => {
    const env = makeTailToggleEnvelope({ on: true });
    expect("filter" in env).toBe(false);
  });
});

describe("makeTailEventEnvelope", () => {
  it("produces a tail-event envelope with all required fields", () => {
    const env = makeTailEventEnvelope({
      from: "peer-a",
      sender: "agent-x",
      recipient: "agent-y",
      envKind: "message",
      body: "hello",
    });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("tail-event");
    expect(env.from).toBe("peer-a");
    expect(env.sender).toBe("agent-x");
    expect(env.recipient).toBe("agent-y");
    expect(env.envKind).toBe("message");
    expect(env.body).toBe("hello");
    expect(typeof env.id).toBe("string");
    expect(typeof env.ts).toBe("number");
  });
});

describe("makeDecisionPendingEnvelope", () => {
  it("produces a v:1 decision-pending envelope with on:true (dialog opened)", () => {
    const env = makeDecisionPendingEnvelope({ peer: "authority", on: true });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("decision-pending");
    expect(env.peer).toBe("authority");
    expect(env.on).toBe(true);
    expect(typeof env.id).toBe("string");
    expect(typeof env.ts).toBe("number");
  });

  it("produces a v:1 decision-pending envelope with on:false (dialog resolved)", () => {
    const env = makeDecisionPendingEnvelope({ peer: "authority", on: false });
    expect(env.on).toBe(false);
    expect(env.peer).toBe("authority");
  });

  it("round-trips through encodeEnvelope / tryDecodeEnvelope", () => {
    const env = makeDecisionPendingEnvelope({ peer: "top-supervisor", on: true });
    const result = tryDecodeEnvelope(encodeEnvelope(env));
    expect(result.env).not.toBeNull();
    expect(result.env?.kind).toBe("decision-pending");
    expect(result.env?.peer).toBe("top-supervisor");
    expect(result.env?.on).toBe(true);
  });
});

describe("makePinRequestEnvelope", () => {
  it("produces a v:1 pin-request envelope with all required fields", () => {
    const env = makePinRequestEnvelope({
      msg_id: "msg-123",
      peer: "authority",
      kind: "approval-request",
      summary: "approve build step",
    });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("pin-request");
    expect(env.msg_id).toBe("msg-123");
    expect(env.peer).toBe("authority");
    expect(env.kind_of_decision).toBe("approval-request");
    expect(env.summary).toBe("approve build step");
    expect(typeof env.id).toBe("string");
    expect(typeof env.ts).toBe("number");
  });

  it("round-trips through encode/decode", () => {
    const env = makePinRequestEnvelope({
      msg_id: "msg-456",
      peer: "worker",
      kind: "submission",
      summary: "3 artifacts",
    });
    const result = tryDecodeEnvelope(encodeEnvelope(env));
    expect(result.env).not.toBeNull();
    expect(result.env?.kind).toBe("pin-request");
    expect(result.env?.msg_id).toBe("msg-456");
    expect(result.env?.peer).toBe("worker");
    expect((result.env as any)?.kind_of_decision).toBe("submission");
    expect((result.env as any)?.summary).toBe("3 artifacts");
  });
});

describe("makePinnedResolvedEnvelope", () => {
  it("produces a v:1 pinned-resolved envelope for approve action", () => {
    const env = makePinnedResolvedEnvelope({ msg_id: "msg-789", action: "approve" });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("pinned-resolved");
    expect(env.msg_id).toBe("msg-789");
    expect(env.action).toBe("approve");
    expect("note" in env).toBe(false);
    expect(typeof env.id).toBe("string");
    expect(typeof env.ts).toBe("number");
  });

  it("includes note when provided", () => {
    const env = makePinnedResolvedEnvelope({ msg_id: "msg-789", action: "reject", note: "not now" });
    expect(env.action).toBe("reject");
    expect(env.note).toBe("not now");
  });

  it("omits note when not provided", () => {
    const env = makePinnedResolvedEnvelope({ msg_id: "msg-789", action: "approve" });
    expect("note" in env).toBe(false);
  });

  it("supports revise action", () => {
    const env = makePinnedResolvedEnvelope({ msg_id: "msg-abc", action: "revise", note: "needs work" });
    expect(env.action).toBe("revise");
    expect(env.note).toBe("needs work");
  });

  it("round-trips through encode/decode", () => {
    const env = makePinnedResolvedEnvelope({ msg_id: "msg-round", action: "approve", note: "looks good" });
    const result = tryDecodeEnvelope(encodeEnvelope(env));
    expect(result.env).not.toBeNull();
    expect(result.env?.kind).toBe("pinned-resolved");
    expect(result.env?.msg_id).toBe("msg-round");
    expect(result.env?.action).toBe("approve");
    expect(result.env?.note).toBe("looks good");
  });
});

describe("makeDecisionsJumpEnvelope", () => {
  it("produces a v:1 decisions-jump envelope with from field", () => {
    const env = makeDecisionsJumpEnvelope({ from: "peer-a" });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("decisions-jump");
    expect(env.from).toBe("peer-a");
    expect(typeof env.id).toBe("string");
    expect(typeof env.ts).toBe("number");
  });

  it("round-trips through encode/decode", () => {
    const env = makeDecisionsJumpEnvelope({ from: "authority" });
    const result = tryDecodeEnvelope(encodeEnvelope(env));
    expect(result.env).not.toBeNull();
    expect(result.env?.kind).toBe("decisions-jump");
    expect(result.env?.from).toBe("authority");
  });
});

describe("encodeEnvelope", () => {
  it("produces a newline-terminated JSON string", () => {
    const env = makeFocusChangedEnvelope({ focused: "peer-a" });
    const line = encodeEnvelope(env);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.trim());
    expect(parsed.kind).toBe("focus-changed");
  });
});

describe("tryDecodeEnvelope", () => {
  it("decodes a valid envelope", () => {
    const env = makeFocusChangedEnvelope({ focused: "peer-a" });
    const line = encodeEnvelope(env);
    const result = tryDecodeEnvelope(line);
    expect(result.env).not.toBeNull();
    expect(result.versionMismatch).toBe(false);
    expect(result.env?.kind).toBe("focus-changed");
  });

  it("returns null for invalid JSON", () => {
    const result = tryDecodeEnvelope("not-json");
    expect(result.env).toBeNull();
    expect(result.versionMismatch).toBe(false);
  });

  it("returns versionMismatch:true for v:2 envelope", () => {
    const line = JSON.stringify({ v: 2, id: "x", kind: "focus-changed", ts: Date.now() });
    const result = tryDecodeEnvelope(line);
    expect(result.env).toBeNull();
    expect(result.versionMismatch).toBe(true);
  });

  it("returns null for missing required fields", () => {
    const line = JSON.stringify({ v: 1, kind: "focus-changed" }); // missing id, ts
    const result = tryDecodeEnvelope(line);
    expect(result.env).toBeNull();
    expect(result.versionMismatch).toBe(false);
  });

  it("round-trips all envelope kinds", () => {
    const envelopes = [
      makeFocusChangedEnvelope({ focused: "peer-a" }),
      makeFocusRequestEnvelope({ from: "peer-a", target: "peer-b" }),
      makeSignalEnvelope({ signal: "reload" }),
      makeHeartbeatEnvelope({ from: "peer-a" }),
      makeTailToggleEnvelope({ on: true, filter: "message" }),
      makeTailEventEnvelope({
        from: "peer-a",
        sender: "agent-x",
        recipient: "agent-y",
        envKind: "submission",
        body: "2 artifacts",
      }),
      makeDecisionPendingEnvelope({ peer: "authority", on: true }),
      makePinRequestEnvelope({ msg_id: "m1", peer: "p1", kind: "approval-request", summary: "s" }),
      makePinnedResolvedEnvelope({ msg_id: "m2", action: "approve" }),
      makeDecisionsJumpEnvelope({ from: "peer-a" }),
    ];
    for (const env of envelopes) {
      const result = tryDecodeEnvelope(encodeEnvelope(env));
      expect(result.env).not.toBeNull();
      expect(result.env?.id).toBe(env.id);
    }
  });
});
