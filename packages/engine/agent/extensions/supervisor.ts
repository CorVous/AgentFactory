// supervisor extension — inbound rail for approval-request and submission
// envelopes, plus the respond_to_request tool.
//
// Loaded as a baseline extension by the engine for every recipe. Both
// this extension and intercept self-gate via getHabitat().acceptedFrom —
// no-ops when the topology assigns no inbound peers. Registers a globalThis
// hook so peer-bus.ts can forward typed inbound envelopes here instead of
// the general inbox.
//
// The testable core lives in ../lib/supervisor-inbox.ts.
//
// Top Supervisor escalate path:
// When the Top Supervisor's LLM picks escalate and no supervisor peer is
// configured, localEscalate is invoked. This opens ctx.ui.confirm in this
// peer's own TUI. Before opening, a decision-pending(on:true) envelope is
// sent to the launcher so the mesh-rail widget can show a badge if the human is
// focused elsewhere. After the human decides, decision-pending(on:false)
// clears the badge.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getHabitat, tryGetHabitat } from "../lib/habitat.js";
import { createSupervisorInbox, type InboundEnvelope } from "../lib/supervisor-inbox.js";
import {
  makeApprovalRequestEnvelope,
  encodeEnvelope,
  tryDecodeEnvelope,
  type Envelope,
} from "../lib/bus-envelope.js";
import { sendOverBus } from "../lib/bus-transport.js";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

interface SupervisorState {
  inbox: ReturnType<typeof createSupervisorInbox>;
  agentName: string;
  busRoot: string;
  /** Captured from pi.sendUserMessage at session_start. Allows dispatchToSupervisor
   *  to deliver messages directly without going through a turn_end queue. */
  sendUserMessage?: (text: string, opts: { deliverAs: "followUp" }) => void;
  /** ExtensionContext captured at session_start — used for localEscalate dialog. */
  ctx: ExtensionContext | null;
}

function getState(): SupervisorState {
  const g = globalThis as { __pi_supervisor__?: SupervisorState };
  return (g.__pi_supervisor__ ??= {
    inbox: createSupervisorInbox(),
    agentName: "supervisor",
    busRoot: "",
    ctx: null,
  });
}

// ---------------------------------------------------------------------------
// Launcher bridge helpers (for decision-pending signals)
// ---------------------------------------------------------------------------

/** Send a control envelope to the launcher via launcher-bridge (if connected). */
function sendControlToLauncher(env: Record<string, unknown>): void {
  // Lazy-access the launcher-bridge module to avoid circular dependency at
  // module load time. launcher-bridge may not be loaded in standalone mode.
  const g = globalThis as {
    __pi_launcher_bridge__?: {
      client: { send: (env: Record<string, unknown>) => boolean } | null;
      ready: boolean;
    };
  };
  const bridge = g.__pi_launcher_bridge__;
  if (!bridge?.ready || !bridge.client) return;
  try {
    bridge.client.send(env);
  } catch {
    // best-effort; standalone mode or launcher not running
  }
}

/** Signal the launcher that this peer has opened or resolved a decision dialog. */
function signalDecisionPending(agentName: string, on: boolean): void {
  // Import makeDecisionPendingEnvelope lazily so this file doesn't acquire a
  // hard dependency on the lib at module parse time.
  try {
    const { makeDecisionPendingEnvelope } = _require(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "../lib/launcher-envelope.mjs"),
    ) as { makeDecisionPendingEnvelope: (args: { peer: string; on: boolean }) => Record<string, unknown> };
    const env = makeDecisionPendingEnvelope({ peer: agentName, on });
    sendControlToLauncher(env);
  } catch {
    // Module not available (standalone mode) — silently ignore.
  }
}

// ---------------------------------------------------------------------------
// Local escalation dialog (Top Supervisor path)
// ---------------------------------------------------------------------------

/**
 * Show a local ctx.ui.confirm dialog for the Top Supervisor escalation path.
 * Emits decision-pending signals to the launcher before and after so the
 * mesh-rail widget can show/hide the badge when the human is focused elsewhere.
 */
async function runLocalEscalateDialog(
  ctx: ExtensionContext,
  agentName: string,
  req: { title: string; summary: string; preview: string },
): Promise<{ approved: boolean; note?: string }> {
  // Signal to the launcher that a decision is pending (badge appears in mesh-rail).
  signalDecisionPending(agentName, true);

  let approved = false;
  let note: string | undefined;

  try {
    const title = `[Top Supervisor] Escalation: ${req.title}`;
    const choices = ["approve", "reject"];
    let picked: string | undefined;
    try {
      picked = await ctx.ui.select(title + `\n\n${req.summary}`, choices);
    } catch {
      // Dialog cancelled (e.g. process shutdown) — default to reject.
      picked = "reject";
    }

    approved = picked === "approve";

    // Optionally prompt for a note.
    try {
      const input = await ctx.ui.input(
        approved ? "Approval note (optional)" : "Rejection reason (optional)",
        "",
      );
      note = input && input.trim() ? input.trim() : undefined;
    } catch {
      note = undefined;
    }

    if (approved) {
      ctx.ui.notify(`[supervisor] escalation approved by human`, "info");
    } else {
      ctx.ui.notify(`[supervisor] escalation rejected by human`, "info");
    }
  } finally {
    // Always clear the badge when the dialog closes (whether resolved or thrown).
    signalDecisionPending(agentName, false);
  }

  return { approved, note };
}

// Called by peer-bus.ts's handleIncoming to forward typed envelopes.
// Returns true if the envelope was consumed (approval-request or submission).
// The inbox's dispatchEnvelope internally buffers during turns when inTurn=true;
// turn-end flushing is handled by the turn_end listener registered below.
export function dispatchToSupervisor(env: Envelope): boolean {
  const kind = env.payload.kind;
  if (kind !== "approval-request" && kind !== "submission") return false;
  const state = getState();
  state.inbox.dispatchEnvelope(env, (_msgId, text) => {
    // Deliver directly to the model via the pi.sendUserMessage reference
    // captured at session_start. During turns, the inbox buffers the envelope
    // and this callback is only invoked at turnEnd (for batch delivery).
    if (state.sendUserMessage) {
      try {
        state.sendUserMessage(text, { deliverAs: "followUp" });
      } catch { /* best-effort */ }
    }
  });
  return true;
}

// Register the supervisor hook on globalThis so peer-bus can find it.
function registerDispatchHook(): void {
  (globalThis as { __pi_supervisor_dispatch__?: typeof dispatchToSupervisor }).__pi_supervisor_dispatch__ =
    dispatchToSupervisor;
}

// Send an envelope to a named peer on the bus.
async function sendToPeer(
  busRoot: string,
  env: Envelope,
): Promise<{ delivered: boolean; reason?: string }> {
  return sendOverBus(busRoot, env.to, encodeEnvelope(env));
}

// Escalate to the supervisor via bus peer_call pattern:
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
        const decoded = tryDecodeEnvelope(line);
        if (decoded?.payload?.kind === "approval-result") {
          clearTimeout(timer);
          const p = decoded.payload;
          settle({ approved: p.approved, note: p.note });
          return;
        }
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
    // Capture ctx so respondToRequest can provide localEscalate.
    state.ctx = ctx;

    const _h = tryGetHabitat();
    if (_h) {
      state.agentName = _h.instanceName;
      state.busRoot = _h.busRoot;
      // Replace inbox with a fresh one for this session
      state.inbox = createSupervisorInbox();
    } /* else: Habitat not available — leave defaults */

    // Capture pi.sendUserMessage so dispatchToSupervisor can deliver inbound
    // envelopes immediately — no turn_end queue. An envelope arriving mid-turn
    // while pi's loop is live goes through pi.sendUserMessage directly;
    // peer-bus's own pendingDuringTurn queue handles the actual delivery
    // ordering for the message kind; typed envelopes come here.
    state.sendUserMessage = (text, opts) => pi.sendUserMessage(text, opts);

    try {
      if (getHabitat().debug === true) {
        ctx.ui.notify("supervisor: inbound rail active", "info");
      }
    } catch { /* Habitat not available */ }
  });

  pi.on("turn_start", async () => {
    state.inbox.turnStart();
  });

  pi.on("turn_end", async () => {
    state.inbox.turnEnd((_msgId, text) => {
      if (state.sendUserMessage) {
        try {
          state.sendUserMessage(text, { deliverAs: "followUp" });
        } catch { /* best-effort */ }
      }
    });
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

      const ctx = state.ctx;
      const agentName = state.agentName;
      const result = await state.inbox.respondToRequest({
        msg_id: params.msg_id,
        action: params.action,
        note: params.note,
        agentName,
        sendEnvelope: (env: InboundEnvelope) => sendToPeer(busRoot, env),
        escalateToSupervisor: async (supervisorName, req) =>
          escalateViaBus(busRoot, agentName, supervisorName, req),
        // Top Supervisor local escalation: when no supervisor peer is configured,
        // surface the prompt to the human via ctx.ui.confirm in this TUI.
        localEscalate: ctx
          ? (req) => runLocalEscalateDialog(ctx, agentName, req)
          : undefined,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `respond_to_request failed: ${result.error}` }],
          details: { ok: false, error: result.error },
        };
      }
      return {
        content: [{ type: "text", text: `respond_to_request(${params.action}) sent for ${params.msg_id.slice(0, 8)}.` }],
        details: { ok: true, error: undefined },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    // Clear ctx so no stale reference is held after the session ends.
    state.ctx = null;
    state.sendUserMessage = undefined;
  });
}
