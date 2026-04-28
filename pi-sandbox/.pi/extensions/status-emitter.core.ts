// Testable core for status-emitter.ts. Owns: throttle logic, envelope
// construction, and the send call. Dependency-injected so tests can stub
// out the actual socket send without touching real bus sockets.

import { encodeEnvelope, makeStatusEnvelope } from "./_lib/bus-envelope";
import type { BusSendResult } from "./_lib/bus-transport";

export interface EmitterContext {
  agentName: string;
  submitTo: string | undefined;
  busRoot: string;
  modelId: string;
  getCostUsd: () => number;
  getTurnCount: () => number;
  getContextUsage: () => { percent: number; tokens: number; windowSize: number } | null;
}

export interface EmitterDeps {
  send: (busRoot: string, toName: string, line: string) => Promise<BusSendResult>;
}

export interface StatusEmitter {
  emit(state: "running" | "paused" | "settled"): Promise<void>;
}

const THROTTLE_MS = 250;

export function createStatusEmitter(ctx: EmitterContext, deps: EmitterDeps): StatusEmitter {
  let lastEmitAt = 0;

  return {
    async emit(state: "running" | "paused" | "settled"): Promise<void> {
      // Gate: no submitTo configured → inert.
      if (!ctx.submitTo) return;

      const now = Date.now();
      // Throttle: skip unless 250ms has elapsed OR state is "settled" (always send final state).
      if (state !== "settled" && now - lastEmitAt < THROTTLE_MS) return;
      lastEmitAt = now;

      const usage = ctx.getContextUsage();
      const env = makeStatusEnvelope({
        from: ctx.agentName,
        to: ctx.submitTo,
        agentName: ctx.agentName,
        modelId: ctx.modelId,
        contextPct: usage?.percent ?? 0,
        contextTokens: usage?.tokens ?? 0,
        contextWindow: usage?.windowSize ?? 0,
        costUsd: ctx.getCostUsd(),
        turnCount: ctx.getTurnCount(),
        state,
      });

      try {
        await deps.send(ctx.busRoot, ctx.submitTo, encodeEnvelope(env));
      } catch {
        // Best-effort: status emission failures are non-fatal.
      }
    },
  };
}
