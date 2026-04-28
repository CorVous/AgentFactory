import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStatusCache, type StatusEntry } from "./status-cache";
import { makeStatusEnvelope, makeMessageEnvelope } from "./bus-envelope";

function makeStatusEnv(from: string, state: "running" | "paused" | "settled" = "running") {
  return makeStatusEnvelope({
    from,
    to: "supervisor",
    agentName: from,
    modelId: "test-model",
    contextPct: 10,
    contextTokens: 1000,
    contextWindow: 8000,
    costUsd: 0.001,
    turnCount: 1,
    state,
  });
}

describe("createStatusCache", () => {
  describe("record", () => {
    it("returns true and stores a status envelope keyed by from", () => {
      const cache = createStatusCache();
      const env = makeStatusEnv("worker-a");
      expect(cache.record(env)).toBe(true);
      const entries = cache.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.from).toBe("worker-a");
    });

    it("overwrites prior entry for the same from", () => {
      const cache = createStatusCache();
      cache.record(makeStatusEnv("worker-a"));
      const env2 = makeStatusEnvelope({
        from: "worker-a",
        to: "supervisor",
        agentName: "worker-a",
        modelId: "test-model",
        contextPct: 50,
        contextTokens: 4000,
        contextWindow: 8000,
        costUsd: 0.002,
        turnCount: 2,
        state: "running",
      });
      cache.record(env2);
      const entries = cache.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.turnCount).toBe(2);
      expect(entries[0]!.contextPct).toBe(50);
    });

    it("stores multiple entries for different from values", () => {
      const cache = createStatusCache();
      cache.record(makeStatusEnv("worker-a"));
      cache.record(makeStatusEnv("worker-b"));
      expect(cache.entries()).toHaveLength(2);
    });

    it("returns false and does not store a non-status envelope", () => {
      const cache = createStatusCache();
      const env = makeMessageEnvelope({ from: "worker-a", to: "supervisor", text: "hello" });
      expect(cache.record(env)).toBe(false);
      expect(cache.entries()).toHaveLength(0);
    });

    it("populates all StatusEntry fields from the envelope", () => {
      const cache = createStatusCache();
      const env = makeStatusEnvelope({
        from: "worker-a",
        to: "supervisor",
        agentName: "dutch-writer",
        modelId: "deepseek/deepseek-v3",
        contextPct: 42.5,
        contextTokens: 12000,
        contextWindow: 32000,
        costUsd: 0.0099,
        turnCount: 5,
        state: "settled",
      });
      cache.record(env);
      const [entry] = cache.entries() as [StatusEntry];
      expect(entry.from).toBe("worker-a");
      expect(entry.agentName).toBe("dutch-writer");
      expect(entry.modelId).toBe("deepseek/deepseek-v3");
      expect(entry.contextPct).toBe(42.5);
      expect(entry.contextTokens).toBe(12000);
      expect(entry.contextWindow).toBe(32000);
      expect(entry.costUsd).toBe(0.0099);
      expect(entry.turnCount).toBe(5);
      expect(entry.state).toBe("settled");
    });
  });

  describe("entries — TTL eviction", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns entries within TTL", () => {
      const cache = createStatusCache({ evictAfterMs: 1000 });
      cache.record(makeStatusEnv("worker-a"));
      vi.advanceTimersByTime(500);
      expect(cache.entries()).toHaveLength(1);
    });

    it("lazily evicts entries older than evictAfterMs on entries() access", () => {
      const cache = createStatusCache({ evictAfterMs: 1000 });
      cache.record(makeStatusEnv("worker-a"));
      vi.advanceTimersByTime(1001);
      expect(cache.entries()).toHaveLength(0);
    });

    it("evicts expired entries but keeps fresh ones", () => {
      const cache = createStatusCache({ evictAfterMs: 1000 });
      cache.record(makeStatusEnv("worker-a")); // recorded at t=0
      vi.advanceTimersByTime(600);
      cache.record(makeStatusEnv("worker-b")); // recorded at t=600
      vi.advanceTimersByTime(500); // now t=1100; worker-a is 1100ms old, worker-b is 500ms old
      const entries = cache.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.from).toBe("worker-b");
    });

    it("defaults to 30 second TTL", () => {
      const cache = createStatusCache(); // default TTL
      cache.record(makeStatusEnv("worker-a"));
      vi.advanceTimersByTime(29_999);
      expect(cache.entries()).toHaveLength(1);
      vi.advanceTimersByTime(2); // now 30001ms old
      expect(cache.entries()).toHaveLength(0);
    });
  });

  describe("subscribe", () => {
    it("fires callback when record stores a new entry", () => {
      const cache = createStatusCache();
      const cb = vi.fn();
      cache.subscribe(cb);
      cache.record(makeStatusEnv("worker-a"));
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("fires callback when record overwrites an existing entry", () => {
      const cache = createStatusCache();
      const cb = vi.fn();
      cache.record(makeStatusEnv("worker-a")); // before subscribe
      cache.subscribe(cb);
      cache.record(makeStatusEnv("worker-a")); // overwrite
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("does not fire callback when record rejects a non-status envelope", () => {
      const cache = createStatusCache();
      const cb = vi.fn();
      cache.subscribe(cb);
      const env = makeMessageEnvelope({ from: "a", to: "b", text: "hi" });
      cache.record(env);
      expect(cb).not.toHaveBeenCalled();
    });

    it("unsubscribe stops callback from firing", () => {
      const cache = createStatusCache();
      const cb = vi.fn();
      const unsub = cache.subscribe(cb);
      unsub();
      cache.record(makeStatusEnv("worker-a"));
      expect(cb).not.toHaveBeenCalled();
    });

    it("multiple subscribers all fire on record", () => {
      const cache = createStatusCache();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      cache.subscribe(cb1);
      cache.subscribe(cb2);
      cache.record(makeStatusEnv("worker-a"));
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it("unsubscribing one does not affect another", () => {
      const cache = createStatusCache();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const unsub1 = cache.subscribe(cb1);
      cache.subscribe(cb2);
      unsub1();
      cache.record(makeStatusEnv("worker-a"));
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });
});
