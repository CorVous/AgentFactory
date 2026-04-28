// Submission-emit helpers for the worker-side bus-routed approval flow.
// Used by deferred-confirm.ts when getHabitat().submitTo is set.
//
// The pending-submissions Map is stashed on globalThis so agent-bus.ts can
// dispatch supervisor replies into it from a different module graph —
// the same pattern as deferred-confirm's handler registry.

import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { encodeEnvelope, makeSubmissionEnvelope, type Artifact, type Envelope } from "./bus-envelope";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Artifact builders
// ---------------------------------------------------------------------------

export function buildWriteArtifact(args: { relPath: string; content: string }): Artifact {
  return { kind: "write", relPath: args.relPath, content: args.content, sha256: sha256(args.content) };
}

export function buildEditArtifact(args: {
  relPath: string;
  originalContent: string;
  edits: Array<{ oldString: string; newString: string }>;
}): Artifact {
  return {
    kind: "edit",
    relPath: args.relPath,
    sha256OfOriginal: sha256(args.originalContent),
    edits: args.edits,
  };
}

export function buildMoveArtifact(args: { src: string; dst: string; sourceContent: string }): Artifact {
  return { kind: "move", src: args.src, dst: args.dst, sha256OfSource: sha256(args.sourceContent) };
}

export function buildDeleteArtifact(args: { relPath: string; content: string }): Artifact {
  return { kind: "delete", relPath: args.relPath, sha256: sha256(args.content) };
}

// ---------------------------------------------------------------------------
// Pending submission registry (globalThis-backed)
// ---------------------------------------------------------------------------

export interface SubmissionReply {
  approved: boolean;
  note?: string;
  revisionNote?: string;
  /** msg_id of the outbound submission this reply settles. Used by the worker
   *  to thread the next submission via in_reply_to when the supervisor asks
   *  for a revision. */
  originalMsgId: string;
}

export interface PendingSubmission {
  resolve: (reply: SubmissionReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function getPendingSubmissionsMap(): Map<string, PendingSubmission> {
  const g = globalThis as { __pi_pending_submissions__?: Map<string, PendingSubmission> };
  return (g.__pi_pending_submissions__ ??= new Map());
}

export function getPendingSubmissions(): Map<string, PendingSubmission> {
  return getPendingSubmissionsMap();
}

// ---------------------------------------------------------------------------
// Last-submission-msgid store (globalThis-backed)
//
// When the supervisor asks for a revision, the worker stashes the original
// submission's msg_id here so the *next* submission can link back via
// in_reply_to. The slot is consumed by `takeLastSubmissionMsgId` so a
// freshly-approved (or rejected) thread doesn't leak into a future
// unrelated task.
// ---------------------------------------------------------------------------

interface LastSubmissionMsgIdSlot {
  id: string | undefined;
}

function getLastSubmissionMsgIdSlot(): LastSubmissionMsgIdSlot {
  const g = globalThis as { __pi_last_submission_msgid__?: LastSubmissionMsgIdSlot };
  return (g.__pi_last_submission_msgid__ ??= { id: undefined });
}

export function storeLastSubmissionMsgId(id: string): void {
  getLastSubmissionMsgIdSlot().id = id;
}

export function takeLastSubmissionMsgId(): string | undefined {
  const slot = getLastSubmissionMsgIdSlot();
  const id = slot.id;
  slot.id = undefined;
  return id;
}

// ---------------------------------------------------------------------------
// Dispatch helper — called by agent-bus.ts when a reply arrives
// ---------------------------------------------------------------------------

export function dispatchSubmissionReply(env: Envelope): boolean {
  if (!env.in_reply_to) return false;
  const kind = env.payload.kind;
  if (kind !== "approval-result" && kind !== "revision-requested") return false;
  const pending = getPendingSubmissionsMap().get(env.in_reply_to);
  if (!pending) return false;
  clearTimeout(pending.timer);
  getPendingSubmissionsMap().delete(env.in_reply_to);
  const originalMsgId = env.in_reply_to;
  if (kind === "approval-result") {
    const p = env.payload;
    pending.resolve({ approved: p.approved, note: p.note, originalMsgId });
  } else {
    // revision-requested: revisionNote carries the supervisor's note. The
    // worker side handles re-prompting the model (see handleSubmissionReply).
    const p = env.payload;
    pending.resolve({ approved: false, revisionNote: p.note, originalMsgId });
  }
  return true;
}

// ---------------------------------------------------------------------------
// shipSubmission
// ---------------------------------------------------------------------------

export interface ShipContext {
  busRoot: string;
  agentName: string;
  submitTo: string;
  sendEnvelope: (env: Envelope) => Promise<{ delivered: boolean; reason?: string }>;
  timeoutMs?: number;
  /** When set, the outbound submission envelope's `in_reply_to` field is
   *  populated. The supervisor uses this to recognise a revision continuation
   *  on an already-pending thread instead of opening a fresh one. */
  in_reply_to?: string;
}

export async function shipSubmission(
  ctx: ShipContext,
  artifacts: Artifact[],
  summary?: string,
): Promise<SubmissionReply> {
  const envArgs: Parameters<typeof makeSubmissionEnvelope>[0] = {
    from: ctx.agentName,
    to: ctx.submitTo,
    artifacts,
  };
  if (summary !== undefined) envArgs.summary = summary;
  if (ctx.in_reply_to !== undefined) envArgs.in_reply_to = ctx.in_reply_to;

  const env = makeSubmissionEnvelope(envArgs);
  const sendResult = await ctx.sendEnvelope(env);

  if (!sendResult.delivered) {
    throw new Error(
      `shipSubmission: failed to deliver to '${ctx.submitTo}': ${sendResult.reason ?? "unknown"}`,
    );
  }

  const timeoutMs = ctx.timeoutMs ?? 5 * 60 * 1000;

  return new Promise<SubmissionReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      getPendingSubmissionsMap().delete(env.msg_id);
      reject(
        new Error(
          `shipSubmission: timed out waiting for reply from '${ctx.submitTo}' (${timeoutMs}ms)`,
        ),
      );
    }, timeoutMs);
    getPendingSubmissionsMap().set(env.msg_id, { resolve, reject, timer });
  });
}

// ---------------------------------------------------------------------------
// Worker-side reply handling (called by deferred-confirm.ts)
// ---------------------------------------------------------------------------

/** Build the synthetic user prompt that re-asks the model to redo the
 *  submission. The 8-char msg_id prefix gives the model a stable reference
 *  it can quote when reasoning about which thread the note belongs to. */
export function composeRevisionPrompt(originalMsgId: string, note: string): string {
  return `[supervisor revise re:${originalMsgId.slice(0, 8)}] ${note}`;
}

export interface WorkerReplyHandler {
  /** Equivalent to `pi.sendUserMessage` — surfaces a synthetic user turn. */
  sendUserMessage: (text: string, opts: { deliverAs: "followUp" }) => void;
  /** Equivalent to `tell(ctx, level, message)` from deferred-confirm. */
  notify: (level: "info" | "error", message: string) => void;
}

/** Route a SubmissionReply to the appropriate side-effects on the worker:
 *   - approved → notify only.
 *   - revisionNote → store the original msg_id (so the next submission can
 *     thread via in_reply_to) and re-prompt the model.
 *   - rejected (no revisionNote) → notify only. */
export function handleSubmissionReply(
  reply: SubmissionReply,
  handler: WorkerReplyHandler,
): void {
  if (reply.approved) {
    handler.notify("info", "submission applied by supervisor");
    return;
  }
  if (reply.revisionNote !== undefined) {
    storeLastSubmissionMsgId(reply.originalMsgId);
    handler.sendUserMessage(
      composeRevisionPrompt(reply.originalMsgId, reply.revisionNote),
      { deliverAs: "followUp" },
    );
    handler.notify("info", `revision requested: ${reply.revisionNote}`);
    return;
  }
  handler.notify("info", `submission rejected: ${reply.note ?? "(no reason)"}`);
}

// ---------------------------------------------------------------------------
// Production socket sender — used by deferred-confirm.ts
// ---------------------------------------------------------------------------

export function makeBusSender(
  busRoot: string,
): (env: Envelope) => Promise<{ delivered: boolean; reason?: string }> {
  return (env) => {
    const dest = path.join(busRoot, `${env.to}.sock`);
    return new Promise((resolve) => {
      const sock = net.connect(dest);
      const done = (r: { delivered: boolean; reason?: string }) => {
        sock.removeAllListeners();
        sock.destroy();
        resolve(r);
      };
      const timer = setTimeout(() => done({ delivered: false, reason: "timeout" }), 1_000);
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
  };
}
