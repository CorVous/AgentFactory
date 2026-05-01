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
    ];
    for (const env of envelopes) {
      const result = tryDecodeEnvelope(encodeEnvelope(env));
      expect(result.env).not.toBeNull();
      expect(result.env?.id).toBe(env.id);
    }
  });
});
