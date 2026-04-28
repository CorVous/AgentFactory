// Tests for the status-emitter extension's testable core.
// The extension itself is thin pi-API wiring; we test the logic layer:
// - makeEmitStatus: builds a status envelope from session context and sends
// - throttle: at most one send per 250ms
// - settle-state on agent_end
//
// We stub sendOverBus via dependency injection so no real sockets occur.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createStatusEmitter,
  type EmitterContext,
  type EmitterDeps,
} from "./status-emitter.core";

function makeCtx(overrides?: Partial<EmitterContext>): EmitterContext {
  return {
    agentName: "dutch-writer",
    submitTo: "foreman",
    busRoot: "/tmp/test-bus",
    modelId: "deepseek/v3",
    getCostUsd: () => 0.001,
    getTurnCount: () => 2,
    getContextUsage: () => ({ percent: 25, tokens: 2000, windowSize: 8000 }),
    ...overrides,
  };
}

function makeDeps(): EmitterDeps & { sent: { to: string; payload: unknown }[] } {
  const sent: { to: string; payload: unknown }[] = [];
  return {
    sent,
    send: vi.fn(async (_busRoot: string, to: string, line: string) => {
      try { sent.push({ to, payload: JSON.parse(line) }); } catch { /* ignore */ }
      return { delivered: true };
    }),
  };
}

describe("createStatusEmitter", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("emits a status envelope with kind=status and correct fields", async () => {
    const deps = makeDeps();
    const emitter = createStatusEmitter(makeCtx(), deps);
    await emitter.emit("running");
    expect(deps.sent).toHaveLength(1);
    const env = deps.sent[0]!.payload as { payload: Record<string, unknown> };
    expect(env.payload.kind).toBe("status");
    expect(env.payload.agentName).toBe("dutch-writer");
    expect(env.payload.state).toBe("running");
    expect(env.payload.costUsd).toBe(0.001);
    expect(env.payload.turnCount).toBe(2);
    expect(env.payload.contextPct).toBe(25);
    expect(env.payload.contextTokens).toBe(2000);
    expect(env.payload.contextWindow).toBe(8000);
    expect(env.payload.modelId).toBe("deepseek/v3");
  });

  it("sends to the submitTo peer", async () => {
    const deps = makeDeps();
    const emitter = createStatusEmitter(makeCtx(), deps);
    await emitter.emit("running");
    expect(deps.sent[0]!.to).toBe("foreman");
  });

  it("does not emit when throttle window has not elapsed", async () => {
    const deps = makeDeps();
    const emitter = createStatusEmitter(makeCtx(), deps);
    await emitter.emit("running");
    await emitter.emit("running"); // within 250ms
    expect(deps.sent).toHaveLength(1);
  });

  it("emits again after throttle window elapses", async () => {
    const deps = makeDeps();
    const emitter = createStatusEmitter(makeCtx(), deps);
    await emitter.emit("running");
    vi.advanceTimersByTime(251);
    await emitter.emit("running");
    expect(deps.sent).toHaveLength(2);
  });

  it("always emits settled state bypassing throttle", async () => {
    const deps = makeDeps();
    const emitter = createStatusEmitter(makeCtx(), deps);
    await emitter.emit("running"); // uses throttle slot
    await emitter.emit("settled"); // settled bypasses throttle
    expect(deps.sent).toHaveLength(2);
    expect((deps.sent[1]!.payload as { payload: { state: string } }).payload.state).toBe("settled");
  });

  it("is inert (does not call send) when submitTo is undefined", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ submitTo: undefined });
    const emitter = createStatusEmitter(ctx, deps);
    await emitter.emit("running");
    expect(deps.sent).toHaveLength(0);
  });

  it("does not throw when send fails", async () => {
    const deps = makeDeps();
    deps.send = vi.fn(async () => ({ delivered: false, reason: "peer offline" }));
    const emitter = createStatusEmitter(makeCtx(), deps);
    await expect(emitter.emit("running")).resolves.not.toThrow();
  });

  it("uses contextPct=0 and contextTokens=0 when getContextUsage returns null", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ getContextUsage: () => null });
    const emitter = createStatusEmitter(ctx, deps);
    await emitter.emit("running");
    const payload = (deps.sent[0]!.payload as { payload: Record<string, unknown> }).payload;
    expect(payload.contextPct).toBe(0);
    expect(payload.contextTokens).toBe(0);
    expect(payload.contextWindow).toBe(0);
  });
});
