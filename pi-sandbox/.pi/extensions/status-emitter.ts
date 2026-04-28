// status-emitter — baseline extension that emits status envelopes to this
// peer's submitTo target when `getHabitat().submitTo` is set.
//
// Self-gates on submitTo being configured — if not set, all event hooks
// are no-ops. Throttles to one emission per 250ms (the "settled" state
// on agent_end always bypasses the throttle so the final state lands).
//
// Hooks: turn_start, turn_end, tool_execution_end, after_provider_response,
// agent_end. Mirrors the deleted agent-status-reporter.ts hook set.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { getHabitat } from "./_lib/habitat";
import { sendOverBus } from "./_lib/bus-transport";
import { createStatusEmitter } from "./status-emitter.core";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    let submitTo: string | undefined;
    let agentName = "anonymous";
    let busRoot = "";

    try {
      const h = getHabitat();
      submitTo = h.submitTo;
      agentName = h.agentName;
      busRoot = h.busRoot;
    } catch {
      // Habitat not available — extension is inert.
      return;
    }

    if (!submitTo) return; // No submitTo configured → fully inert.

    const modelId = ctx.model?.id ?? "unknown";

    function getCostUsd(): number {
      let cost = 0;
      try {
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            cost += (entry.message as AssistantMessage).usage.cost.total;
          }
        }
      } catch { /* best-effort */ }
      return cost;
    }

    function getTurnCount(): number {
      let turns = 0;
      try {
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") turns++;
        }
      } catch { /* best-effort */ }
      return turns;
    }

    function getContextUsage() {
      try {
        const u = ctx.getContextUsage();
        if (!u) return null;
        return { percent: u.percent, tokens: u.tokensUsed, windowSize: u.maxTokens };
      } catch {
        return null;
      }
    }

    const emitter = createStatusEmitter(
      { agentName, submitTo, busRoot, modelId, getCostUsd, getTurnCount, getContextUsage },
      { send: sendOverBus },
    );

    pi.on("turn_start", async () => { await emitter.emit("running"); });
    pi.on("turn_end", async () => { await emitter.emit("running"); });
    pi.on("tool_execution_end", async () => { await emitter.emit("running"); });
    pi.on("after_provider_response", async () => { await emitter.emit("running"); });
    pi.on("agent_end", async () => { await emitter.emit("settled"); });
  });
}
