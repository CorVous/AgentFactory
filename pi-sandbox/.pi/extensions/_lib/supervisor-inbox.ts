// Supervisor inbox core logic — testable without the pi ExtensionAPI.
//
// supervisor.ts wraps this with the pi tool registration; tests drive
// it directly with mocked sendEnvelope / escalateToSupervisor callbacks.

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
  dispatchEnvelope(env: Envelope, sendMessage: (msgId: string, text: string) => void): void;
  updatePendingMsgId(oldMsgId: string, newMsgId: string, newEnv: Envelope): void;
  respondToRequest(opts: RespondOpts): Promise<RespondResult>;
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
}

export interface RespondResult {
  ok: boolean;
  error?: string;
}

function getPendingRegistry(): Map<string, PendingEntry> {
  const g = globalThis as { __pi_supervisor_pending__?: Map<string, PendingEntry> };
  return (g.__pi_supervisor_pending__ ??= new Map());
}

function isAllowed(from: string): boolean {
  let acceptedFrom: string[];
  try {
    acceptedFrom = getHabitat().acceptedFrom;
  } catch {
    acceptedFrom = [];
  }
  return acceptedFrom.includes(from);
}

export function createSupervisorInbox(): SupervisorInbox {
  const pending: Map<string, PendingEntry> = new Map();

  return {
    pendingCount() {
      return pending.size;
    },

    dispatchEnvelope(env: Envelope, sendMessage: (msgId: string, text: string) => void) {
      const kind = env.payload.kind;
      if (kind !== "approval-request" && kind !== "submission") return;

      if (!isAllowed(env.from)) {
        if (process.env.AGENT_DEBUG === "1") {
          process.stderr.write(
            `[supervisor] dropping ${kind} from '${env.from}': not in acceptedFrom\n`,
          );
        }
        return;
      }

      // Revision continuation: a `submission` whose in_reply_to matches an
      // already-pending entry rebinds that entry to the new msg_id. The
      // revisionCount (incremented at revise-time) carries forward so the
      // cap is enforced across the whole thread, not just one msg_id.
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
          const rendered = renderInboundForUser(env);
          const hint =
            `\n[revision ${existing.revisionCount}] respond_to_request({msg_id: "${env.msg_id}", action: "approve"|"reject"|"revise"|"escalate", note?}) to respond.`;
          sendMessage(env.msg_id, rendered + hint);
          return;
        }
        // in_reply_to points at no live entry — fall through to fresh-thread path.
      }

      pending.set(env.msg_id, {
        env,
        revisionCount: 0,
        rootMsgId: env.msg_id,
      });

      const rendered = renderInboundForUser(env);
      const toolHint = `\nUse respond_to_request({msg_id: "${env.msg_id}", action: "approve"|"reject"|"revise"|"escalate", note?}) to respond.`;
      sendMessage(env.msg_id, rendered + toolHint);
    },

    updatePendingMsgId(oldMsgId: string, newMsgId: string, newEnv: Envelope) {
      const entry = pending.get(oldMsgId);
      if (!entry) return;
      const updated: PendingEntry = {
        env: newEnv,
        revisionCount: entry.revisionCount,
        rootMsgId: entry.rootMsgId,
      };
      pending.delete(oldMsgId);
      pending.set(newMsgId, updated);
    },

    async respondToRequest(opts: RespondOpts): Promise<RespondResult> {
      const entry = pending.get(opts.msg_id);
      if (!entry) {
        return { ok: false, error: `msg_id '${opts.msg_id}' not found in pending inbox` };
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
          if (!supervisorName) {
            return { ok: false, error: "escalate requires no supervisor configured in Habitat" };
          }
          if (!opts.escalateToSupervisor) {
            return { ok: false, error: "escalateToSupervisor callback required for escalate action" };
          }
          const req =
            payload.kind === "approval-request"
              ? { title: payload.title, summary: payload.summary, preview: payload.preview }
              : {
                  title: `Submission from ${env.from}`,
                  summary: (payload as Extract<Payload, { kind: "submission" }>).summary ?? `${(payload as Extract<Payload, { kind: "submission" }>).artifacts.length} artifact(s)`,
                  preview: renderInboundForUser(env),
                };

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
