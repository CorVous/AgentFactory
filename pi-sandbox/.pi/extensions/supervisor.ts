// supervisor extension — inbound rail for approval-request and submission
// envelopes, plus the respond_to_request tool.
//
// Auto-wired by run-agent.mjs when a recipe sets acceptedFrom, supervisor,
// or submitTo. Registers a globalThis hook so agent-bus.ts can forward
// typed inbound envelopes here instead of the general inbox.
//
// The testable core lives in _lib/supervisor-inbox.ts.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { getHabitat } from "./_lib/habitat";
import { createSupervisorInbox, type InboundEnvelope } from "./_lib/supervisor-inbox";
import {
  makeApprovalRequestEnvelope,
  encodeEnvelope,
  type Envelope,
} from "./_lib/bus-envelope";
import { rpcRequestApproval } from "./_lib/escalation";
import net from "node:net";
import path from "node:path";

interface SupervisorState {
  inbox: ReturnType<typeof createSupervisorInbox>;
  agentName: string;
  busRoot: string;
}

function getState(): SupervisorState {
  const g = globalThis as { __pi_supervisor__?: SupervisorState };
  return (g.__pi_supervisor__ ??= {
    inbox: createSupervisorInbox(),
    agentName: "supervisor",
    busRoot: "",
  });
}

// Called by agent-bus.ts's handleIncoming to forward typed envelopes.
// Returns true if the envelope was consumed (approval-request or submission).
export function dispatchToSupervisor(env: Envelope): boolean {
  const kind = env.payload.kind;
  if (kind !== "approval-request" && kind !== "submission") return false;
  const state = getState();
  state.inbox.dispatchEnvelope(env, (msgId, text) => {
    // Delivered to the model via agent-bus's pi reference if available;
    // agent-bus calls renderInboundForUser itself for the general path,
    // so here we just need to make the message available. We store a
    // pending sendUserMessage request on globalThis and let agent-bus
    // drain it via the registered callback.
    const g = globalThis as { __pi_supervisor_pending_msgs__?: Array<string> };
    (g.__pi_supervisor_pending_msgs__ ??= []).push(text);
  });
  return true;
}

// Register the supervisor hook on globalThis so agent-bus can find it.
function registerDispatchHook(): void {
  (globalThis as { __pi_supervisor_dispatch__?: typeof dispatchToSupervisor }).__pi_supervisor_dispatch__ =
    dispatchToSupervisor;
}

// Send an envelope to a named peer on the bus.
async function sendToPeer(
  busRoot: string,
  env: Envelope,
): Promise<{ delivered: boolean; reason?: string }> {
  const dest = path.join(busRoot, `${env.to}.sock`);
  return new Promise((resolve) => {
    const sock = net.connect(dest);
    const done = (r: { delivered: boolean; reason?: string }) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ delivered: false, reason: "timeout" }), 1000);
    sock.once("connect", () => {
      sock.write(encodeEnvelope(env), "utf8", () => {
        clearTimeout(timer);
        done({ delivered: true });
      });
    });
    sock.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const reason =
        e.code === "ENOENT" || e.code === "ECONNREFUSED"
          ? "peer offline"
          : `socket error: ${e.message}`;
      done({ delivered: false, reason });
    });
  });
}

// Escalate to the supervisor via bus agent_call pattern:
// send an approval-request envelope and wait for an approval-result reply.
async function escalateViaBus(
  busRoot: string,
  agentName: string,
  supervisorName: string,
  req: { title: string; summary: string; preview: string },
): Promise<{ approved: boolean; note?: string }> {
  return new Promise((resolve) => {
    const env = makeApprovalRequestEnvelope({
      from: agentName,
      to: supervisorName,
      ...req,
    });
    const dest = path.join(busRoot, `${supervisorName}.sock`);
    const sock = net.connect(dest);
    let buf = "";
    let settled = false;
    const settle = (r: { approved: boolean; note?: string }) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => settle({ approved: false, note: "escalation timeout" }), 30_000);
    sock.setEncoding("utf8");
    sock.once("connect", () => {
      sock.write(encodeEnvelope(env), "utf8", (err?: Error | null) => {
        if (err) { clearTimeout(timer); settle({ approved: false, note: "send error" }); }
      });
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as { payload?: { kind?: string; approved?: boolean; note?: string } };
          if (raw?.payload?.kind === "approval-result" && typeof raw.payload.approved === "boolean") {
            clearTimeout(timer);
            settle({ approved: raw.payload.approved, note: raw.payload.note });
            return;
          }
        } catch { /* ignore */ }
      }
    });
    sock.once("error", () => { clearTimeout(timer); settle({ approved: false, note: "connection error" }); });
    sock.once("close", () => { clearTimeout(timer); settle({ approved: false, note: "connection closed" }); });
  });
}

export default function (pi: ExtensionAPI) {
  const state = getState();
  registerDispatchHook();

  pi.on("session_start", async (_event, ctx) => {
    try {
      const h = getHabitat();
      state.agentName = h.agentName;
      state.busRoot = h.busRoot;
      // Replace inbox with a fresh one for this session
      state.inbox = createSupervisorInbox();
    } catch {
      /* Habitat not available — leave defaults */
    }

    if (process.env.AGENT_DEBUG === "1") {
      ctx.ui.notify("supervisor: inbound rail active", "info");
    }
  });

  // Drain pending messages queued by dispatchToSupervisor before agent-bus
  // had a pi reference. After session_start, agent-bus holds its own
  // pi.sendUserMessage reference. We hook turn_end to push any queued msgs.
  pi.on("turn_end", async (_event, _ctx) => {
    const g = globalThis as { __pi_supervisor_pending_msgs__?: Array<string> };
    const msgs = g.__pi_supervisor_pending_msgs__ ?? [];
    if (msgs.length === 0) return;
    const drained = msgs.splice(0);
    for (const text of drained) {
      try {
        pi.sendUserMessage(text, { deliverAs: "followUp" });
      } catch { /* best-effort */ }
    }
  });

  pi.registerTool({
    name: "respond_to_request",
    label: "Respond To Request",
    description:
      "Respond to an inbound approval-request or submission from a worker. " +
      "Actions: approve (accept and apply), reject (discard), revise (ask worker to redo; note required), " +
      "escalate (forward to this supervisor's own supervisor and relay the result). " +
      "msg_id comes from the inbound envelope shown in the user message.",
    parameters: Type.Object({
      msg_id: Type.String({ description: "The msg_id of the inbound request to respond to." }),
      action: Type.Union([
        Type.Literal("approve"),
        Type.Literal("reject"),
        Type.Literal("revise"),
        Type.Literal("escalate"),
      ]),
      note: Type.Optional(
        Type.String({ description: "Required for revise. Optional explanatory note for approve/reject." }),
      ),
    }),
    async execute(_id, params) {
      let busRoot = state.busRoot;
      try { busRoot = getHabitat().busRoot; } catch { /* use state */ }

      const result = await state.inbox.respondToRequest({
        msg_id: params.msg_id,
        action: params.action,
        note: params.note,
        agentName: state.agentName,
        sendEnvelope: (env: InboundEnvelope) => sendToPeer(busRoot, env),
        escalateToSupervisor: async (supervisorName, req) => {
          // Prefer bus escalation; fall back to rpc-sock if configured
          let rpcSock: string | undefined;
          try { rpcSock = getHabitat().rpcSock; } catch { /* none */ }
          if (rpcSock) {
            const approved = await rpcRequestApproval(rpcSock, req);
            return { approved };
          }
          return escalateViaBus(busRoot, state.agentName, supervisorName, req);
        },
      });

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `respond_to_request failed: ${result.error}` }],
          details: { ok: false, error: result.error },
        };
      }
      return {
        content: [{ type: "text", text: `respond_to_request(${params.action}) sent for ${params.msg_id.slice(0, 8)}.` }],
        details: { ok: true },
      };
    },
  });
}
