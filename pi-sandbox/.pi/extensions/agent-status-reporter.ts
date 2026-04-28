// agent-status-reporter — child-side companion to agent-spawn's RPC server.
//
// When this agent runs as a delegated child (i.e. Habitat.rpcSock is set),
// open a long-lived connection to the parent's per-call RPC socket and push
// session-stat snapshots whenever the agent's state changes meaningfully
// (turn boundaries, tool boundaries, provider responses). The parent's
// agent-spawn caches the latest snapshot per delegation and the
// delegation-boxes widget renders it above the input.
//
// No-ops for top-level (non-delegated) runs — same gating idiom as
// requestHumanApproval in deferred-confirm.
//
// Failure semantics: best-effort. Connect failures, mid-session
// disconnects, and EPIPE all settle silently after one 500 ms reconnect
// attempt — status is non-fatal, the child must keep running even if
// the parent stops listening.

import net from "node:net";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getHabitat } from "./_lib/habitat";

const THROTTLE_MS = 250;
const RECONNECT_DELAY_MS = 500;

type ReporterState = "running" | "paused" | "settled";

interface ReporterRuntime {
  sock: net.Socket | null;
  reconnectAttempted: boolean;
  pendingTimer: NodeJS.Timeout | null;
  lastSendAt: number;
  helloSent: boolean;
  giveUp: boolean;
  state: ReporterState;
  delegationId: string;
  agentName: string;
}

function computeCost(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      total += (entry.message as AssistantMessage).usage.cost.total;
    }
  }
  return total;
}

function countTurns(ctx: ExtensionContext): number {
  let n = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") n++;
  }
  return n;
}

function buildSnapshot(rt: ReporterRuntime, ctx: ExtensionContext, modelId: string) {
  const usage = ctx.getContextUsage();
  return {
    type: "status" as const,
    delegation_id: rt.delegationId,
    agent_name: rt.agentName,
    model_id: modelId,
    context_pct: usage?.percent ?? 0,
    context_tokens: usage?.tokens ?? 0,
    context_window: usage?.contextWindow ?? 0,
    cost_usd: computeCost(ctx),
    turn_count: countTurns(ctx),
    state: rt.state,
  };
}

function writeLine(sock: net.Socket, obj: unknown): boolean {
  try {
    return sock.write(JSON.stringify(obj) + "\n");
  } catch {
    return false;
  }
}

function send(rt: ReporterRuntime, ctx: ExtensionContext) {
  if (rt.giveUp || !rt.sock || rt.sock.destroyed) return;
  const now = Date.now();
  const sinceLast = now - rt.lastSendAt;
  if (sinceLast < THROTTLE_MS) {
    if (rt.pendingTimer) return;
    rt.pendingTimer = setTimeout(() => {
      rt.pendingTimer = null;
      send(rt, ctx);
    }, THROTTLE_MS - sinceLast);
    return;
  }
  rt.lastSendAt = now;
  if (!rt.helloSent) {
    writeLine(rt.sock, { type: "hello", id: rt.delegationId });
    rt.helloSent = true;
  }
  writeLine(rt.sock, buildSnapshot(rt, ctx, ctx.model?.id ?? ""));
}

function attachSocket(rt: ReporterRuntime, sockPath: string, ctx: ExtensionContext): void {
  const sock = net.connect(sockPath);
  rt.sock = sock;
  rt.helloSent = false;
  sock.once("connect", () => send(rt, ctx));
  sock.once("error", () => handleDisconnect(rt, sockPath, ctx));
  sock.once("close", () => handleDisconnect(rt, sockPath, ctx));
}

function handleDisconnect(rt: ReporterRuntime, sockPath: string, ctx: ExtensionContext): void {
  if (rt.giveUp) return;
  try {
    rt.sock?.destroy();
  } catch {
    /* noop */
  }
  rt.sock = null;
  rt.helloSent = false;
  if (rt.reconnectAttempted) {
    rt.giveUp = true;
    return;
  }
  rt.reconnectAttempted = true;
  setTimeout(() => {
    if (rt.giveUp) return;
    attachSocket(rt, sockPath, ctx);
  }, RECONNECT_DELAY_MS);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Read rpcSock, delegationId, and agentName from Habitat.
    // Falls back to env vars so the extension keeps working if habitat.ts
    // somehow loaded without a valid spec (e.g. a stale child invoked
    // without the runner).
    let sockPath = "";
    let delegationId = "";
    let agentName = "agent";
    try {
      const h = getHabitat();
      sockPath = (h.rpcSock || "").trim();
      delegationId = (h.delegationId || "").trim();
      agentName = (h.agentName || "agent").trim() || "agent";
    } catch {
      sockPath = (process.env.PI_RPC_SOCK || "").trim();
      delegationId = (process.env.PI_AGENT_DELEGATION_ID || "").trim();
      agentName = (process.env.PI_AGENT_NAME || "agent").trim() || "agent";
    }

    if (!sockPath) return; // top-level run, no parent to talk to
    if (!delegationId) return; // spawned without a delegation id; can't be routed

    const rt: ReporterRuntime = {
      sock: null,
      reconnectAttempted: false,
      pendingTimer: null,
      lastSendAt: 0,
      helloSent: false,
      giveUp: false,
      state: "running",
      delegationId,
      agentName,
    };

    attachSocket(rt, sockPath, ctx);

    const tick = () => send(rt, ctx);
    pi.on("turn_start", async () => {
      rt.state = "running";
      tick();
    });
    pi.on("turn_end", async () => {
      tick();
    });
    pi.on("tool_execution_end", async () => {
      tick();
    });
    pi.on("after_provider_response", async () => {
      tick();
    });
    pi.on("agent_end", async () => {
      // The deferred-confirm handler runs after this; if it forwards an
      // approval request, the child is effectively paused awaiting the
      // parent's decision. Reporting "paused" here lets the box's state
      // line transition before the approval round-trip completes.
      rt.state = "paused";
      tick();
    });
  });
}
