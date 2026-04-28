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

export interface PendingSubmission {
  resolve: (reply: { approved: boolean; note?: string; revisionNote?: string }) => void;
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
  if (kind === "approval-result") {
    const p = env.payload;
    pending.resolve({ approved: p.approved, note: p.note });
  } else {
    // revision-requested: Phase 4a treats as reject+log; revisionNote carries the note.
    const p = env.payload;
    pending.resolve({ approved: false, revisionNote: p.note });
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
}

export async function shipSubmission(
  ctx: ShipContext,
  artifacts: Artifact[],
  summary?: string,
): Promise<{ approved: boolean; note?: string; revisionNote?: string }> {
  const envArgs: Parameters<typeof makeSubmissionEnvelope>[0] = {
    from: ctx.agentName,
    to: ctx.submitTo,
    artifacts,
  };
  if (summary !== undefined) envArgs.summary = summary;

  const env = makeSubmissionEnvelope(envArgs);
  const sendResult = await ctx.sendEnvelope(env);

  if (!sendResult.delivered) {
    throw new Error(
      `shipSubmission: failed to deliver to '${ctx.submitTo}': ${sendResult.reason ?? "unknown"}`,
    );
  }

  const timeoutMs = ctx.timeoutMs ?? 5 * 60 * 1000;

  return new Promise<{ approved: boolean; note?: string; revisionNote?: string }>((resolve, reject) => {
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
