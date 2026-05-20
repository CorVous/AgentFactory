// intercept extension — focus-driven ctx.ui.confirm for the supervisor inbound rail.
//
// When this peer is the currently focused peer in the launcher TUI AND a
// `submission` or `approval-request` envelope arrives, intercept routes the
// decision to the human via ctx.ui.select / ctx.ui.input instead of injecting
// the prompt into the LLM via respond_to_request.
//
// When NOT focused, or when no supervisor inbound rail is loaded (empty
// acceptedFrom), the extension is a silent no-op.
//
// Hard-cancel semantics (Q12): when the human shifts focus away from this peer
// while a dialog is open, the dialog is cancelled via AbortController and the
// original envelope prompt is re-injected to the LLM as a fresh turn.
//
// Auto-loaded by run-agent.mjs alongside supervisor.ts when any supervisory
// peer field (acceptedFrom, supervisor, submitTo) is set.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getHabitat } from "./_lib/habitat";
import {
  makeApprovalResultEnvelope,
  makeRevisionRequestedEnvelope,
  renderInboundForUser,
  type Envelope,
} from "./_lib/bus-envelope";
import { sendOverBus } from "./_lib/bus-transport";
import { routeEnvelope, isTopSupervisor, hasSupervisorInboundRail } from "./_lib/intercept";

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

interface InterceptState {
  ctx: ExtensionContext | null;
  pi: ExtensionAPI | null;
  agentName: string;
  busRoot: string;
  /** AbortController for the currently-open dialog, or null if none. */
  pendingAbort: AbortController | null;
  /**
   * The original message text for the pending envelope (rendered for the LLM).
   * Stored so we can re-inject it if focus changes.
   */
  pendingMessageText: string | null;
  /** The pending envelope itself (kept for debug / future use). */
  pendingEnv: Envelope | null;
  /** Original supervisor dispatch hook saved before we overwrite it. */
  originalDispatch: ((env: Envelope) => boolean) | null;
  /** Whether we are wired (i.e. acceptedFrom is non-empty). */
  active: boolean;
}

/**
 * Current decision payload exposed to slash-commands via globalThis.
 * Set when a ctx.ui.confirm dialog is open; cleared when it resolves or aborts.
 * The /pin slash command reads this to build a pin-request envelope.
 */
export interface CurrentDecisionPayload {
  msg_id: string;
  peer: string;
  kind: string;
  summary: string;
}

function setCurrentDecision(payload: CurrentDecisionPayload | null): void {
  (globalThis as { __pi_current_decision__?: CurrentDecisionPayload | null }).__pi_current_decision__ = payload;
}

export function getCurrentDecision(): CurrentDecisionPayload | null {
  const g = globalThis as { __pi_current_decision__?: CurrentDecisionPayload | null };
  return g.__pi_current_decision__ ?? null;
}

function getState(): InterceptState {
  const g = globalThis as { __pi_intercept__?: InterceptState };
  return (g.__pi_intercept__ ??= {
    ctx: null,
    pi: null,
    agentName: "unknown",
    busRoot: "",
    pendingAbort: null,
    pendingMessageText: null,
    pendingEnv: null,
    originalDispatch: null,
    active: false,
  });
}

// ---------------------------------------------------------------------------
// FocusState accessor (reads from launcher-bridge's globalThis slot)
// ---------------------------------------------------------------------------

interface FocusStateHandle {
  isFocused(): boolean;
  on(event: "focus-changed", listener: (ev: { focused: boolean }) => void): void;
  off(event: "focus-changed", listener: (ev: { focused: boolean }) => void): void;
}

function getFocusStateHandle(): FocusStateHandle | null {
  const g = globalThis as {
    __pi_launcher_bridge__?: { focusState: FocusStateHandle | null };
  };
  return g.__pi_launcher_bridge__?.focusState ?? null;
}

// ---------------------------------------------------------------------------
// Outbound bus helpers
// ---------------------------------------------------------------------------

async function sendApprovalResult(opts: {
  busRoot: string;
  agentName: string;
  to: string;
  inReplyTo: string;
  approved: boolean;
  note?: string;
}): Promise<void> {
  const env = makeApprovalResultEnvelope({
    from: opts.agentName,
    to: opts.to,
    in_reply_to: opts.inReplyTo,
    approved: opts.approved,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  });
  await sendOverBus(opts.busRoot, opts.to, `${JSON.stringify(env)}\n`);
}

async function sendRevisionRequested(opts: {
  busRoot: string;
  agentName: string;
  to: string;
  inReplyTo: string;
  note: string;
}): Promise<void> {
  const env = makeRevisionRequestedEnvelope({
    from: opts.agentName,
    to: opts.to,
    in_reply_to: opts.inReplyTo,
    note: opts.note,
  });
  await sendOverBus(opts.busRoot, opts.to, `${JSON.stringify(env)}\n`);
}

// ---------------------------------------------------------------------------
// Human dialog flow
// ---------------------------------------------------------------------------

/**
 * Show the intercept dialog for an inbound envelope. Returns after the human
 * picks an action (or the dialog is cancelled via abort).
 *
 * If the dialog is aborted (focus change), falls through to the LLM path
 * by re-injecting the original message text via pi.sendUserMessage.
 */
async function handleHumanDecision(env: Envelope): Promise<void> {
  const state = getState();
  const ctx = state.ctx;
  const pi = state.pi;

  if (!ctx || !pi) return;

  // Determine if escalate is available (disabled for Top Supervisor).
  let supervisorName: string | undefined;
  try {
    supervisorName = getHabitat().supervisor;
  } catch {
    supervisorName = undefined;
  }
  const topSupervisor = isTopSupervisor(supervisorName);

  // Build the action list shown to the human.
  // escalate is excluded when this peer is the Top Supervisor (no peer above).
  const actions = ["approve", "reject", "revise"];
  if (!topSupervisor) actions.push("escalate");

  // Build the dialog title from the envelope.
  const title = `Intercept: ${env.payload.kind} from ${env.from}`;
  const summary = renderInboundForUser(env);

  // Register the pending abort controller so the focus-change handler can cancel it.
  const abort = new AbortController();
  state.pendingAbort = abort;

  // Expose the current decision payload to slash-commands (/pin reads this).
  setCurrentDecision({
    msg_id: env.msg_id,
    peer: env.from,
    kind: env.payload.kind,
    summary: title,
  });

  let pickedAction: string | undefined;
  try {
    pickedAction = await ctx.ui.select(title, actions, { signal: abort.signal });
  } catch {
    // Aborted (focus change) or dialog threw — fall through to LLM re-injection below.
    pickedAction = undefined;
  }

  // Clear current decision exposure and pending abort state.
  setCurrentDecision(null);
  state.pendingAbort = null;

  if (!pickedAction || abort.signal.aborted) {
    // Focus changed (hard-cancel): re-inject the original prompt to the LLM.
    const msgText = state.pendingMessageText;
    state.pendingMessageText = null;
    state.pendingEnv = null;

    if (msgText) {
      try {
        await pi.sendUserMessage(msgText, { deliverAs: "followUp" });
      } catch {
        // best-effort
      }
    }
    return;
  }

  // Clear stored text now that the human has picked.
  state.pendingMessageText = null;
  state.pendingEnv = null;

  const { busRoot, agentName } = state;

  // Emit the summary so the operator can see what was intercepted (notification
  // bar, not a blocking dialog).
  void summary; // referenced for documentation clarity

  // Handle each action.
  switch (pickedAction) {
    case "approve": {
      // Optional note for approve.
      let note: string | undefined;
      try {
        const input = await ctx.ui.input("Note (optional — leave blank to skip)", "");
        note = input && input.trim() ? input.trim() : undefined;
      } catch {
        note = undefined;
      }
      await sendApprovalResult({
        busRoot,
        agentName,
        to: env.from,
        inReplyTo: env.msg_id,
        approved: true,
        note,
      });
      ctx.ui.notify(`[intercept] approved ${env.msg_id.slice(0, 8)} from ${env.from}`, "info");
      break;
    }

    case "reject": {
      let note: string | undefined;
      try {
        const input = await ctx.ui.input("Reason (optional — leave blank to skip)", "");
        note = input && input.trim() ? input.trim() : undefined;
      } catch {
        note = undefined;
      }
      await sendApprovalResult({
        busRoot,
        agentName,
        to: env.from,
        inReplyTo: env.msg_id,
        approved: false,
        note,
      });
      ctx.ui.notify(`[intercept] rejected ${env.msg_id.slice(0, 8)} from ${env.from}`, "info");
      break;
    }

    case "revise": {
      // Note is required for revise.
      let note = "";
      while (!note.trim()) {
        try {
          const input = await ctx.ui.input("Revision note (required — describe what needs changing)", "");
          note = input ?? "";
        } catch {
          // If this is cancelled (e.g. focus change mid-note prompt), treat as reject.
          await sendApprovalResult({
            busRoot,
            agentName,
            to: env.from,
            inReplyTo: env.msg_id,
            approved: false,
            note: "revise cancelled",
          });
          return;
        }
        if (!note.trim()) {
          ctx.ui.notify("[intercept] note is required for revise — please provide feedback", "warning");
        }
      }
      await sendRevisionRequested({
        busRoot,
        agentName,
        to: env.from,
        inReplyTo: env.msg_id,
        note: note.trim(),
      });
      ctx.ui.notify(`[intercept] revision requested for ${env.msg_id.slice(0, 8)} from ${env.from}`, "info");
      break;
    }

    case "escalate": {
      if (topSupervisor || !supervisorName) {
        ctx.ui.notify("[intercept] escalate not available: no supervisor configured", "error");
        return;
      }
      // Forward the envelope to the configured supervisor (same as the LLM
      // would do via respond_to_request escalate action).
      await sendApprovalResult({
        busRoot,
        agentName,
        to: env.from,
        inReplyTo: env.msg_id,
        approved: false,
        note: "escalated by operator",
      });
      ctx.ui.notify(`[intercept] escalated ${env.msg_id.slice(0, 8)} to ${supervisorName}`, "info");
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatch hook — wraps supervisor's __pi_supervisor_dispatch__
// ---------------------------------------------------------------------------

function buildInterceptDispatch(
  originalDispatch: ((env: Envelope) => boolean) | null,
): (env: Envelope) => boolean {
  return function interceptDispatch(env: Envelope): boolean {
    const state = getState();
    if (!state.active) {
      // No supervisor inbound rail — pass through to original.
      return originalDispatch ? originalDispatch(env) : false;
    }

    const kind = env.payload.kind;
    const focusState = getFocusStateHandle();
    const focused = focusState ? focusState.isFocused() : false;
    const route = routeEnvelope(kind, focused);

    if (route !== "human") {
      // Not intercepted: fall through to LLM path via original supervisor dispatch.
      return originalDispatch ? originalDispatch(env) : false;
    }

    // Human path: build the message text for potential LLM re-injection,
    // store it, then launch the dialog asynchronously.
    const rendered = renderInboundForUser(env);
    const toolHint = `\nUse respond_to_request({msg_id: "${env.msg_id}", action: "approve"|"reject"|"revise"|"escalate", note?}) to respond.`;
    const messageText = rendered + toolHint;

    state.pendingEnv = env;
    state.pendingMessageText = messageText;

    // Fire the dialog flow asynchronously — do not await here so the bus
    // connection handler returns promptly.
    void handleHumanDecision(env).catch((err) => {
      try {
        if (getHabitat().debug === true) {
          process.stderr.write(`[intercept] handleHumanDecision error: ${String(err)}\n`);
        }
      } catch { /* Habitat not available */ }
    });

    // Returning true tells agent-bus the envelope was consumed.
    return true;
  };
}

// ---------------------------------------------------------------------------
// Focus-change handler — hard-cancel on focus away
// ---------------------------------------------------------------------------

function handleFocusChanged(ev: { focused: boolean }): void {
  if (ev.focused) return; // gained focus — nothing to cancel
  // Lost focus while a dialog was open — cancel it.
  const state = getState();
  if (state.pendingAbort && !state.pendingAbort.signal.aborted) {
    state.pendingAbort.abort();
    // state.pendingAbort is cleared by handleHumanDecision after the abort resolves.
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const state = getState();

  pi.on("session_start", async (_event, ctx) => {
    // Capture ctx and pi for use in the dialog flow.
    state.ctx = ctx;
    state.pi = pi;

    // Determine whether the supervisor inbound rail is active.
    let acceptedFrom: string[] = [];
    let busRoot = "";
    let agentName = "unknown";
    try {
      const h = getHabitat();
      acceptedFrom = h.acceptedFrom;
      busRoot = h.busRoot;
      agentName = h.agentName;
    } catch {
      /* Habitat not yet available */
    }
    state.busRoot = busRoot;
    state.agentName = agentName;

    // Only wire if the supervisor inbound rail is active.
    if (!hasSupervisorInboundRail(acceptedFrom)) {
      state.active = false;
      try {
        if (getHabitat().debug === true) {
          ctx.ui.notify("intercept: no supervisor inbound rail — no-op", "info");
        }
      } catch { /* Habitat not available */ }
      return;
    }

    state.active = true;

    // Subscribe to focus-change events for hard-cancel.
    const focusState = getFocusStateHandle();
    if (focusState) {
      focusState.on("focus-changed", handleFocusChanged);
    }

    // Wrap the existing supervisor dispatch hook.
    // supervisor.ts must load before intercept.ts so the hook exists.
    const g = globalThis as {
      __pi_supervisor_dispatch__?: (env: Envelope) => boolean;
    };
    const originalDispatch = g.__pi_supervisor_dispatch__ ?? null;
    state.originalDispatch = originalDispatch;
    g.__pi_supervisor_dispatch__ = buildInterceptDispatch(originalDispatch);

    try {
      if (getHabitat().debug === true) {
        ctx.ui.notify("intercept: focus-driven intercept rail active", "info");
      }
    } catch { /* Habitat not available */ }
  });

  pi.on("session_end", async () => {
    const state = getState();
    // Restore original dispatch hook on cleanup.
    if (state.originalDispatch !== null) {
      const g = globalThis as {
        __pi_supervisor_dispatch__?: (env: Envelope) => boolean;
      };
      g.__pi_supervisor_dispatch__ = state.originalDispatch;
    }

    // Unsubscribe focus-change handler.
    const focusState = getFocusStateHandle();
    if (focusState) {
      focusState.off("focus-changed", handleFocusChanged);
    }

    // Cancel any pending dialog.
    if (state.pendingAbort && !state.pendingAbort.signal.aborted) {
      state.pendingAbort.abort();
    }

    state.ctx = null;
    state.pi = null;
    state.pendingAbort = null;
    state.pendingMessageText = null;
    state.pendingEnv = null;
    state.active = false;
  });
}
