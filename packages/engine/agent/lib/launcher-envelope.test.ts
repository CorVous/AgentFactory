/**
 * launcher-envelope.test.ts — hermetic unit tests for the engine-lib
 * launcher wire format (packages/engine/agent/lib/launcher-envelope.mjs).
 *
 * Covers the existing builders plus the new Slice 4 builders:
 *   makeSpawnRequestEnvelope, makeSpawnResultEnvelope, makeKillRequestEnvelope
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
  makeMeshRailUpdateEnvelope,
  makeSpawnRequestEnvelope,
  makeSpawnResultEnvelope,
  makeKillRequestEnvelope,
  encodeEnvelope,
  tryDecodeEnvelope,
} from "./launcher-envelope.mjs";

// ── Existing builders (smoke tests) ─────────────────────────────────────────

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

describe("encodeEnvelope + tryDecodeEnvelope round-trips", () => {
  it("round-trips a focus-changed envelope", () => {
    const env = makeFocusChangedEnvelope({ focused: "peer-a" });
    const result = tryDecodeEnvelope(encodeEnvelope(env));
    expect(result.env).not.toBeNull();
    expect(result.env?.kind).toBe("focus-changed");
    expect(result.env?.id).toBe(env.id);
  });

  it("returns versionMismatch:true for v:2", () => {
    const line = JSON.stringify({ v: 2, id: "x", kind: "focus-changed", ts: Date.now() });
    const result = tryDecodeEnvelope(line);
    expect(result.env).toBeNull();
    expect(result.versionMismatch).toBe(true);
  });

  it("returns null for invalid JSON", () => {
    const result = tryDecodeEnvelope("not-json");
    expect(result.env).toBeNull();
    expect(result.versionMismatch).toBe(false);
  });
});

// ── Slice 4: spawn-request ────────────────────────────────────────────────────

describe("makeSpawnRequestEnvelope", () => {
  it("produces a v:1 spawn-request with required fields", () => {
    const env = makeSpawnRequestEnvelope({
      msg_id: "req-1",
      from: "worker-a",
      recipe: "mesh-node",
    });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("spawn-request");
    expect(env.msg_id).toBe("req-1");
    expect(env.from).toBe("worker-a");
    expect(env.recipe).toBe("mesh-node");
    expect(typeof env.id).toBe("string");
    expect(typeof env.ts).toBe("number");
  });

  it("omits optional fields when not provided", () => {
    const env = makeSpawnRequestEnvelope({
      msg_id: "req-2",
      from: "worker-b",
      recipe: "mesh-node",
    });
    expect("name" in env).toBe(false);
    expect("groups" in env).toBe(false);
    expect("escalatesTo" in env).toBe(false);
    expect("submitsWorkTo" in env).toBe(false);
    expect("messagesWith" in env).toBe(false);
    expect("acceptsWorkFrom" in env).toBe(false);
    expect("task" in env).toBe(false);
    expect("workspace" in env).toBe(false);
  });

  it("includes optional fields when provided", () => {
    const env = makeSpawnRequestEnvelope({
      msg_id: "req-3",
      from: "worker-c",
      recipe: "mesh-writer",
      name: "scribe-1",
      groups: ["drafting"],
      escalatesTo: "authority",
      submitsWorkTo: "authority",
      messagesWith: ["authority", "worker-c"],
      acceptsWorkFrom: ["authority"],
      task: "draft a README",
      workspace: { include: ["src/"] },
    });
    expect(env.name).toBe("scribe-1");
    expect(env.groups).toEqual(["drafting"]);
    expect(env.escalatesTo).toBe("authority");
    expect(env.submitsWorkTo).toBe("authority");
    expect(env.messagesWith).toEqual(["authority", "worker-c"]);
    expect(env.acceptsWorkFrom).toEqual(["authority"]);
    expect(env.task).toBe("draft a README");
    expect(env.workspace).toEqual({ include: ["src/"] });
  });

  it("round-trips through encodeEnvelope/tryDecodeEnvelope", () => {
    const env = makeSpawnRequestEnvelope({
      msg_id: "req-rt",
      from: "worker-a",
      recipe: "mesh-node",
      name: "node-1",
      groups: ["research"],
    });
    const result = tryDecodeEnvelope(encodeEnvelope(env));
    expect(result.env).not.toBeNull();
    expect(result.env?.kind).toBe("spawn-request");
    expect(result.env?.msg_id).toBe("req-rt");
    expect((result.env as any)?.recipe).toBe("mesh-node");
    expect((result.env as any)?.name).toBe("node-1");
    expect((result.env as any)?.groups).toEqual(["research"]);
  });
});

// ── Slice 4: spawn-result ────────────────────────────────────────────────────

describe("makeSpawnResultEnvelope", () => {
  it("produces a v:1 spawn-result (success) with in_reply_to correlation", () => {
    const env = makeSpawnResultEnvelope({
      msg_id: "res-1",
      in_reply_to: "req-1",
      ok: true,
      name: "node-spawned",
    });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("spawn-result");
    expect(env.msg_id).toBe("res-1");
    expect(env.in_reply_to).toBe("req-1");
    expect(env.ok).toBe(true);
    expect(env.name).toBe("node-spawned");
    expect("error" in env).toBe(false);
    expect(typeof env.id).toBe("string");
    expect(typeof env.ts).toBe("number");
  });

  it("produces a v:1 spawn-result (failure) with error message", () => {
    const env = makeSpawnResultEnvelope({
      msg_id: "res-2",
      in_reply_to: "req-2",
      ok: false,
      error: "recipe not allowed",
    });
    expect(env.ok).toBe(false);
    expect(env.error).toBe("recipe not allowed");
    expect("name" in env).toBe(false);
  });

  it("omits optional fields when not provided", () => {
    const env = makeSpawnResultEnvelope({
      msg_id: "res-3",
      in_reply_to: "req-3",
      ok: true,
    });
    expect("name" in env).toBe(false);
    expect("error" in env).toBe(false);
  });

  it("preserves in_reply_to for correlation with request msg_id", () => {
    const reqId = "req-corr-abc";
    const env = makeSpawnResultEnvelope({
      msg_id: "res-corr-xyz",
      in_reply_to: reqId,
      ok: true,
      name: "worker-corr",
    });
    expect(env.in_reply_to).toBe(reqId);
  });

  it("round-trips through encodeEnvelope/tryDecodeEnvelope", () => {
    const env = makeSpawnResultEnvelope({
      msg_id: "res-rt",
      in_reply_to: "req-rt",
      ok: true,
      name: "rt-worker",
    });
    const result = tryDecodeEnvelope(encodeEnvelope(env));
    expect(result.env).not.toBeNull();
    expect(result.env?.kind).toBe("spawn-result");
    expect(result.env?.msg_id).toBe("res-rt");
    expect((result.env as any)?.in_reply_to).toBe("req-rt");
    expect((result.env as any)?.ok).toBe(true);
    expect((result.env as any)?.name).toBe("rt-worker");
  });

  it("round-trips failure result through encode/decode", () => {
    const env = makeSpawnResultEnvelope({
      msg_id: "res-fail",
      in_reply_to: "req-fail",
      ok: false,
      error: "recipe 'unknown' not in allowed list",
    });
    const result = tryDecodeEnvelope(encodeEnvelope(env));
    expect(result.env).not.toBeNull();
    expect((result.env as any)?.ok).toBe(false);
    expect((result.env as any)?.error).toBe("recipe 'unknown' not in allowed list");
    expect("name" in (result.env as any)).toBe(false);
  });
});

// ── Slice 4: kill-request ────────────────────────────────────────────────────

describe("makeKillRequestEnvelope", () => {
  it("produces a v:1 kill-request with from and target", () => {
    const env = makeKillRequestEnvelope({
      msg_id: "kill-1",
      from: "worker-a",
      target: "node-b",
    });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("kill-request");
    expect(env.msg_id).toBe("kill-1");
    expect(env.from).toBe("worker-a");
    expect(env.target).toBe("node-b");
    expect(typeof env.id).toBe("string");
    expect(typeof env.ts).toBe("number");
  });

  it("round-trips through encodeEnvelope/tryDecodeEnvelope", () => {
    const env = makeKillRequestEnvelope({
      msg_id: "kill-rt",
      from: "host",
      target: "stale-worker",
    });
    const result = tryDecodeEnvelope(encodeEnvelope(env));
    expect(result.env).not.toBeNull();
    expect(result.env?.kind).toBe("kill-request");
    expect(result.env?.msg_id).toBe("kill-rt");
    expect((result.env as any)?.from).toBe("host");
    expect((result.env as any)?.target).toBe("stale-worker");
  });
});

// ── Correlation round-trip: spawn-request msg_id → spawn-result in_reply_to ─

describe("spawn-request / spawn-result correlation", () => {
  it("in_reply_to matches the original spawn-request msg_id", () => {
    const req = makeSpawnRequestEnvelope({
      msg_id: "corr-test-001",
      from: "orchestrator",
      recipe: "mesh-writer",
    });
    const res = makeSpawnResultEnvelope({
      msg_id: "corr-test-002",
      in_reply_to: req.msg_id as string,
      ok: true,
      name: "corr-worker",
    });
    expect(res.in_reply_to).toBe(req.msg_id);
    // Also verify each gets a unique envelope id
    expect(req.id).not.toBe(res.id);
  });

  it("round-trips the full correlation pair", () => {
    const req = makeSpawnRequestEnvelope({
      msg_id: "corr-rt-req",
      from: "spawner",
      recipe: "mesh-node",
      task: "analyze data",
    });
    const res = makeSpawnResultEnvelope({
      msg_id: "corr-rt-res",
      in_reply_to: req.msg_id as string,
      ok: true,
      name: "analyst-1",
    });

    const decodedReq = tryDecodeEnvelope(encodeEnvelope(req));
    const decodedRes = tryDecodeEnvelope(encodeEnvelope(res));

    expect(decodedReq.env).not.toBeNull();
    expect(decodedRes.env).not.toBeNull();
    expect((decodedRes.env as any)?.in_reply_to).toBe((decodedReq.env as any)?.msg_id);
  });
});

// ── makeMeshRailUpdateEnvelope (from scripts copy) ────────────────────────────

describe("makeMeshRailUpdateEnvelope", () => {
  it("produces a v:1 mesh-rail-update envelope", () => {
    const env = makeMeshRailUpdateEnvelope({
      peers: [{ name: "p", state: "running", decisionPending: false }],
      decisionCount: 0,
    });
    expect(env.v).toBe(1);
    expect(env.kind).toBe("mesh-rail-update");
    expect(env.decisionCount).toBe(0);
  });

  it("omits decisions when not provided", () => {
    const env = makeMeshRailUpdateEnvelope({ peers: [], decisionCount: 0 });
    expect("decisions" in env).toBe(false);
  });

  it("includes decisions when provided", () => {
    const decisions = [
      { msg_id: "m1", peer: "p1", kind: "approval-request", summary: "s", pinned: false },
    ];
    const env = makeMeshRailUpdateEnvelope({ peers: [], decisionCount: 1, decisions });
    expect((env as any).decisions).toHaveLength(1);
  });
});

// ── makeHeartbeatEnvelope, makeSignalEnvelope etc. ───────────────────────────

describe("makeHeartbeatEnvelope", () => {
  it("produces a heartbeat from the given peer", () => {
    const env = makeHeartbeatEnvelope({ from: "peer-a" });
    expect(env.kind).toBe("heartbeat");
    expect(env.from).toBe("peer-a");
  });
});

describe("makeTailToggleEnvelope", () => {
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
    expect(env.kind).toBe("tail-event");
    expect(env.from).toBe("peer-a");
    expect(env.sender).toBe("agent-x");
    expect(env.recipient).toBe("agent-y");
    expect(env.envKind).toBe("message");
    expect(env.body).toBe("hello");
  });
});

describe("makePinnedResolvedEnvelope", () => {
  it("omits note when not provided", () => {
    const env = makePinnedResolvedEnvelope({ msg_id: "m", action: "approve" });
    expect("note" in env).toBe(false);
  });

  it("includes note when provided", () => {
    const env = makePinnedResolvedEnvelope({ msg_id: "m", action: "reject", note: "not now" });
    expect(env.note).toBe("not now");
  });
});
