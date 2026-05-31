// Supervisor inbox core logic — testable without the pi ExtensionAPI.
//
// supervisor.ts wraps this with the pi tool registration; tests drive
// it directly with mocked sendEnvelope / escalateToSupervisor callbacks.
//
// Turn-batch behaviour (Slice 6 composite submissions):
// When `inTurn` is true, dispatched envelopes are buffered in `inTurnBatch`
// rather than immediately calling sendMessage. At turnEnd(), the batch is
// assembled into ONE composite prompt via assembleCompositePrompt and
// sendMessage is called exactly once. This ensures N submissions arriving
// within one turn (e.g. multiple mesh_spawn workers finishing in parallel)
// surface as one composite respond_to_request prompt with a section per
// worker, matching the batching behaviour introduced in Slice 6.
//
// Envelopes arriving between turns (inTurn=false) are dispatched immediately
// (legacy behaviour preserved).

import { getHabitat } from "./habitat";
import {
  makeApprovalResultEnvelope,
  makeRevisionRequestedEnvelope,
  renderInboundForUser,
  type Envelope,
  type Payload,
} from "./bus-envelope";
import { applyArtifacts } from "./submission-apply";

export type InboundEnvelope = Envelope;

const REVISION_CAP = 3;

interface PendingEntry {
  env: Envelope;
  revisionCount: number;
  rootMsgId: string;
}

export interface SupervisorInbox {
  pendingCount(): number;
  /**
   * Dispatch an envelope. If inTurn is true the envelope is buffered; it will
   * be flushed as a composite prompt at turnEnd(). If inTurn is false the
   * envelope is dispatched immediately (legacy behaviour).
   */
  dispatchEnvelope(env: Envelope, sendMessage: (msgId: string, text: string) => void): void;
  respondToRequest(opts: RespondOpts): Promise<RespondResult>;
  /** Call at turn_start. Enables turn-batch buffering. */
  turnStart(): void;
  /**
   * Call at turn_end. Flushes buffered envelopes as one composite prompt via
   * sendMessage (called exactly once when the batch is non-empty).
   */
  turnEnd(sendMessage: (msgId: string, text: string) => void): void;
}

export interface RespondOpts {
  msg_id: string;
  action: "approve" | "reject" | "revise" | "escalate";
  note?: string;
  agentName: string;
  sendEnvelope: (env: Envelope) => Promise<{ delivered: boolean; reason?: string }>;
  escalateToSupervisor?: (
    supervisorName: string,
    req: { title: string; summary: string; preview: string },
  ) => Promise<{ approved: boolean; note?: string }>;
  /**
   * Called when this is the Top Supervisor (no supervisor configured above) and the
   * model picks `escalate`. The callback surfaces the prompt to the human via
   * ctx.ui.confirm in the top supervisor's own TUI. Returns the human's decision.
   */
  localEscalate?: (
    req: { title: string; summary: string; preview: string },
  ) => Promise<{ approved: boolean; note?: string }>;
}

export interface RespondResult {
  ok: boolean;
  error?: string;
}

/**
 * Assemble N queued envelopes into a single composite prompt string.
 *
 * For N===1: returns the EXISTING single-section format, byte-identical to
 * today's per-envelope format (regression-safe).
 * For N>1: returns one string with a numbered "── Submission k of N ──" divider
 * section per envelope, followed by a composite tool hint listing all msg_ids.
 *
 * @param envs  Non-empty array of envelopes to render.
 * @returns     Composite prompt string; always a single string.
 */
export function assembleCompositePrompt(envs: Envelope[]): string {
  if (envs.length === 0) return "";
  if (envs.length === 1) {
    const env = envs[0]!;
    const rendered = renderInboundForUser(env);
    const toolHint = `\nUse respond_to_request({msg_id: "${env.msg_id}", action: "approve"|"reject"|"revise"|"escalate", note?}) to respond.`;
    return rendered + toolHint;
  }

  const sections: string[] = [];
  for (let i = 0; i < envs.length; i++) {
    const env = envs[i]!;
    const header = `── Submission ${i + 1} of ${envs.length} — from ${env.from} (msg_id: ${env.msg_id}) ──`;
    const body = renderInboundForUser(env);
    const hint = `respond_to_request({msg_id: "${env.msg_id}", action: "approve"|"reject"|"revise"|"escalate", note?})`;
    sections.push(`${header}\n${body}\n${hint}`);
  }

  const compositeHint =
    `\n\n${envs.length} submissions arrived in this turn. Respond to each independently using respond_to_request with its msg_id.`;
  return sections.join("\n\n") + compositeHint;
}

/** Returns the synthetic msg_id used when calling sendMessage for a composite batch. */
function compositeMsgId(envs: Envelope[]): string {
  return envs[0]!.msg_id;
}

function isAllowed(from: string): boolean {
  let acceptsWorkFrom: string[];
  try {
    acceptsWorkFrom = getHabitat().acceptsWorkFrom;
  } catch {
    acceptsWorkFrom = [];
  }
  return acceptsWorkFrom.includes(from);
}

/**
 * Eagerly register an envelope in the pending map (before any batching or
 * sendMessage call). This ensures respondToRequest works the instant the
 * model acts — even if the model is mid-turn when the envelope arrives.
 */
function registerPending(pending: Map<string, PendingEntry>, env: Envelope): boolean {
  const kind = env.payload.kind;
  if (kind !== "approval-request" && kind !== "submission") return false;

  // Revision continuation check (for submission with in_reply_to).
  if (kind === "submission" && env.in_reply_to) {
    const existing = pending.get(env.in_reply_to);
    if (existing) {
      const updated: PendingEntry = {
        env,
        revisionCount: existing.revisionCount,
        rootMsgId: existing.rootMsgId,
      };
      pending.delete(env.in_reply_to);
      pending.set(env.msg_id, updated);
      return true; // revision continuation — registered
    }
    // in_reply_to points at no live entry — fresh thread
  }

  pending.set(env.msg_id, {
    env,
    revisionCount: 0,
    rootMsgId: env.msg_id,
  });
  return false; // fresh entry
}

export function createSupervisorInbox(): SupervisorInbox {
  const pending: Map<string, PendingEntry> = new Map();
  const inTurnBatch: Envelope[] = [];
  let inTurn = false;

  return {
    pendingCount() {
      return pending.size;
    },

    turnStart() {
      inTurn = true;
    },

    turnEnd(sendMessage: (msgId: string, text: string) => void) {
      inTurn = false;
      if (inTurnBatch.length === 0) return;
      const batch = inTurnBatch.splice(0);
      const text = assembleCompositePrompt(batch);
      sendMessage(compositeMsgId(batch), text);
    },

    dispatchEnvelope(env: Envelope, sendMessage: (msgId: string, text: string) => void) {
      const kind = env.payload.kind;
      if (kind !== "approval-request" && kind !== "submission") return;

      if (!isAllowed(env.from)) {
        try {
          if (getHabitat().debug === true) {
            process.stderr.write(
              `[supervisor] dropping ${kind} from '${env.from}': not in acceptsWorkFrom\n`,
            );
          }
        } catch { /* Habitat not available */ }
        return;
      }

      // Eagerly register in pending so respondToRequest works immediately.
      const isRevisionContinuation = registerPending(pending, env);

      if (isRevisionContinuation) {
        // Revision continuations always render immediately (they're replies to
        // an existing thread, not part of the fan-out batch). This also means
        // the revision-cap is visible to the model right away.
        const entry = pending.get(env.msg_id)!;
        const rendered = renderInboundForUser(env);
        const hint =
          `\n[revision ${entry.revisionCount}] respond_to_request({msg_id: "${env.msg_id}", action: "approve"|"reject"|"revise"|"escalate", note?}) to respond.`;
        sendMessage(env.msg_id, rendered + hint);
        return;
      }

      // Fresh thread: buffer during turns, immediate outside turns.
      if (inTurn) {
        inTurnBatch.push(env);
        return;
      }

      // Between turns: dispatch immediately (legacy behaviour preserved).
      const rendered = renderInboundForUser(env);
      const toolHint = `\nUse respond_to_request({msg_id: "${env.msg_id}", action: "approve"|"reject"|"revise"|"escalate", note?}) to respond.`;
      sendMessage(env.msg_id, rendered + toolHint);
    },

    async respondToRequest(opts: RespondOpts): Promise<RespondResult> {
      const entry = pending.get(opts.msg_id);
      if (!entry) {
        const emptyMsg =
          pending.size === 0
            ? `respond_to_request: no pending request matches msg_id '${opts.msg_id}' (inbox is empty or msg_id was already resolved)`
            : `msg_id '${opts.msg_id}' not found in pending inbox`;
        return { ok: false, error: emptyMsg };
      }

      const { env } = entry;
      const payload = env.payload as Extract<Payload, { kind: "approval-request" | "submission" }>;

      switch (opts.action) {
        case "approve": {
          if (payload.kind === "submission") {
            // Apply artifacts to the canonical filesystem before replying.
            let canonicalRoot: string;
            try {
              canonicalRoot = getHabitat().scratchRoot;
            } catch {
              return { ok: false, error: "approve (submission): Habitat not available — cannot resolve canonical root" };
            }
            const applyResult = await applyArtifacts(canonicalRoot, payload.artifacts);
            if (!applyResult.ok) {
              const errNote = `apply failed: ${applyResult.errors.join("; ")}`;
              const reply = makeApprovalResultEnvelope({
                from: opts.agentName,
                to: env.from,
                in_reply_to: env.msg_id,
                approved: false,
                note: errNote,
              });
              await opts.sendEnvelope(reply);
              pending.delete(opts.msg_id);
              return { ok: true };
            }
          }
          const reply = makeApprovalResultEnvelope({
            from: opts.agentName,
            to: env.from,
            in_reply_to: env.msg_id,
            approved: true,
            ...(opts.note !== undefined ? { note: opts.note } : {}),
          });
          await opts.sendEnvelope(reply);
          pending.delete(opts.msg_id);
          return { ok: true };
        }

        case "reject": {
          const reply = makeApprovalResultEnvelope({
            from: opts.agentName,
            to: env.from,
            in_reply_to: env.msg_id,
            approved: false,
            ...(opts.note !== undefined ? { note: opts.note } : {}),
          });
          await opts.sendEnvelope(reply);
          pending.delete(opts.msg_id);
          return { ok: true };
        }

        case "revise": {
          if (!opts.note || opts.note.trim() === "") {
            return { ok: false, error: "note is required for revise action" };
          }
          if (entry.revisionCount >= REVISION_CAP) {
            return {
              ok: false,
              error: `revision cap (${REVISION_CAP}) reached for this thread — use approve or reject`,
            };
          }
          const reply = makeRevisionRequestedEnvelope({
            from: opts.agentName,
            to: env.from,
            in_reply_to: env.msg_id,
            note: opts.note,
          });
          await opts.sendEnvelope(reply);
          entry.revisionCount++;
          return { ok: true };
        }

        case "escalate": {
          let supervisorName: string | undefined;
          try {
            supervisorName = getHabitat().supervisor;
          } catch {
            supervisorName = undefined;
          }

          const req =
            payload.kind === "approval-request"
              ? { title: payload.title, summary: payload.summary, preview: payload.preview }
              : {
                  title: `Submission from ${env.from}`,
                  summary: (payload as Extract<Payload, { kind: "submission" }>).summary ?? `${(payload as Extract<Payload, { kind: "submission" }>).artifacts.length} artifact(s)`,
                  preview: renderInboundForUser(env),
                };

          // Top Supervisor path: no peer above — route to local ctx.ui.confirm.
          if (!supervisorName) {
            if (!opts.localEscalate) {
              return { ok: false, error: "escalate: no supervisor configured and no localEscalate callback provided (Top Supervisor must provide localEscalate)" };
            }
            const localResult = await opts.localEscalate(req);
            const reply = makeApprovalResultEnvelope({
              from: opts.agentName,
              to: env.from,
              in_reply_to: env.msg_id,
              approved: localResult.approved,
              ...(localResult.note !== undefined ? { note: localResult.note } : {}),
            });
            await opts.sendEnvelope(reply);
            pending.delete(opts.msg_id);
            return { ok: true };
          }

          // Standard path: forward to configured supervisor peer.
          if (!opts.escalateToSupervisor) {
            return { ok: false, error: "escalateToSupervisor callback required for escalate action" };
          }

          const upstream = await opts.escalateToSupervisor(supervisorName, req);
          const reply = makeApprovalResultEnvelope({
            from: opts.agentName,
            to: env.from,
            in_reply_to: env.msg_id,
            approved: upstream.approved,
            ...(upstream.note !== undefined ? { note: upstream.note } : {}),
          });
          await opts.sendEnvelope(reply);
          pending.delete(opts.msg_id);
          return { ok: true };
        }
      }
    },
  };
}
