// In-memory receiver cache for status envelopes. Keyed by `from` (sender
// instance name); latest status per sender is stored. TTL eviction is lazy
// (evaluated on entries() access). Pub/sub notifies watchers on each
// successful record so the TUI widget can request a re-render.

import type { Envelope } from "./bus-envelope";

export interface StatusEntry {
  from: string;
  receivedAt: number;
  agentName: string;
  modelId: string;
  contextPct: number;
  contextTokens: number;
  contextWindow: number;
  costUsd: number;
  turnCount: number;
  state: "running" | "paused" | "settled";
}

export interface StatusCache {
  /** Record an inbound envelope. Returns true if it was a status envelope and was stored. */
  record(env: Envelope): boolean;
  /** Return all non-evicted entries (lazy TTL eviction on each call). */
  entries(): StatusEntry[];
  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe(callback: () => void): () => void;
}

const DEFAULT_TTL_MS = 30_000;

export function createStatusCache(opts?: { evictAfterMs?: number }): StatusCache {
  const evictAfterMs = opts?.evictAfterMs ?? DEFAULT_TTL_MS;
  const store = new Map<string, StatusEntry>();
  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const cb of subscribers) {
      try { cb(); } catch { /* best-effort */ }
    }
  }

  return {
    record(env: Envelope): boolean {
      if (env.payload.kind !== "status") return false;
      const p = env.payload;
      const entry: StatusEntry = {
        from: env.from,
        receivedAt: Date.now(),
        agentName: p.agentName,
        modelId: p.modelId,
        contextPct: p.contextPct,
        contextTokens: p.contextTokens,
        contextWindow: p.contextWindow,
        costUsd: p.costUsd,
        turnCount: p.turnCount,
        state: p.state,
      };
      store.set(env.from, entry);
      notify();
      return true;
    },

    entries(): StatusEntry[] {
      const now = Date.now();
      const live: StatusEntry[] = [];
      for (const [key, entry] of store) {
        if (now - entry.receivedAt > evictAfterMs) {
          store.delete(key);
        } else {
          live.push(entry);
        }
      }
      return live;
    },

    subscribe(callback: () => void): () => void {
      subscribers.add(callback);
      return () => { subscribers.delete(callback); };
    },
  };
}
