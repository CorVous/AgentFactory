// deferred-confirm extension. Auto-loaded as a baseline extension.
//
// Doubles as:
//   1. A shared registry (the named exports below) that other "deferred-*"
//      extensions import to register end-of-turn handlers.
//   2. The coordinator that, on agent_end, drives every registered handler
//      through prepare -> unified approval prompt -> atomic apply.
//
// When getHabitat().submitTo is set the coordinator instead ships the
// aggregated artifacts to that peer via the bus and waits for a reply,
// skipping the local apply entirely (Phase 4a worker-side emit).
//
// The approval primitive (requestHumanApproval) now lives in _lib/escalation.ts.
//
// The handler array is stashed on globalThis so it's shared across
// extensions even though jiti loads each extension's import graph in
// isolation (loader.js uses `moduleCache: false` and a fresh createJiti
// per extension).

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { requestHumanApproval } from "./_lib/escalation";
import { getHabitat } from "./_lib/habitat";
import {
  shipSubmission,
  makeBusSender,
  takeLastSubmissionMsgId,
  handleSubmissionReply,
  type SubmissionReply,
} from "./_lib/submission-emit";
import type { Artifact } from "./_lib/bus-envelope";
export type { ApprovalRequest } from "./_lib/escalation";

export interface DeferredHandler {
  /** Section header in the unified confirm preview ("Writes", "Edits", "Moves", "Deletes"). */
  label: string;
  /** Owning extension name, surfaced in error messages for diagnostics. */
  extension: string;
  /** Apply order: 10 writes -> 20 edits -> 25 moves -> 30 deletes. */
  priority: number;
  prepare: (ctx: ExtensionContext) => Promise<PrepareResult>;
}

export type PrepareResult =
  | { status: "empty" }
  | { status: "error"; messages: string[] }
  | {
      status: "ok";
      /** One-line summary used in the dialog title (e.g. "3 edits across 2 files"). */
      summary: string;
      /** Detailed preview body, rendered under the section header. */
      preview: string;
      apply: () => Promise<{ wrote: string[]; failed: string[] }>;
      /** Artifacts for the supervisor-routed flow; populated when submitTo is set. */
      artifacts?: Artifact[];
    };

function getHandlers(): DeferredHandler[] {
  const g = globalThis as { __pi_deferred_handlers__?: DeferredHandler[] };
  return (g.__pi_deferred_handlers__ ??= []);
}
const handlers = getHandlers();

export function registerDeferredHandler(h: DeferredHandler): void {
  handlers.push(h);
}

export function listDeferredHandlers(): readonly DeferredHandler[] {
  return handlers;
}

function tell(ctx: ExtensionContext, level: "info" | "error", message: string) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  const tag = level === "error" ? "[deferred:error]" : "[deferred]";
  process.stdout.write(`${tag} ${message}\n`);
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (_event, ctx) => {
    if (handlers.length === 0) return;

    type Prepared = { handler: DeferredHandler; result: PrepareResult };
    const prepared: Prepared[] = [];
    for (const h of handlers) {
      try {
        prepared.push({ handler: h, result: await h.prepare(ctx) });
      } catch (e) {
        prepared.push({
          handler: h,
          result: { status: "error", messages: [(e as Error).message] },
        });
      }
    }

    const errors = prepared.flatMap((p) =>
      p.result.status === "error"
        ? p.result.messages.map((m) => `${p.handler.label}: ${m}`)
        : [],
    );
    if (errors.length > 0) {
      tell(ctx, "error", `deferred batch aborted (re-validation failed):\n${errors.join("\n")}`);
      return;
    }

    type OkEntry = { handler: DeferredHandler; result: Extract<PrepareResult, { status: "ok" }> };
    const oks: OkEntry[] = prepared.flatMap((p) =>
      p.result.status === "ok" ? [{ handler: p.handler, result: p.result }] : [],
    );
    if (oks.length === 0) return;

    oks.sort((a, b) => a.handler.priority - b.handler.priority);

    const summaryLine = oks
      .map((p) => `${p.handler.label.toLowerCase()}: ${p.result.summary}`)
      .join(" · ");

    // --- Supervisor-routed flow (submitTo set) --------------------------------
    let submitTo: string | undefined;
    try { submitTo = getHabitat().submitTo; } catch { submitTo = undefined; }

    if (submitTo) {
      const allArtifacts: Artifact[] = oks.flatMap((o) => o.result.artifacts ?? []);

      let busRoot: string;
      let agentName: string;
      try {
        const h = getHabitat();
        busRoot = h.busRoot;
        agentName = h.agentName;
      } catch {
        tell(ctx, "error", "submission: habitat not available, cannot ship to supervisor");
        return;
      }

      const inReplyTo = takeLastSubmissionMsgId();
      let reply: SubmissionReply;
      try {
        const shipCtx: Parameters<typeof shipSubmission>[0] = {
          busRoot,
          agentName,
          submitTo,
          sendEnvelope: makeBusSender(busRoot),
        };
        if (inReplyTo !== undefined) shipCtx.in_reply_to = inReplyTo;
        reply = await shipSubmission(shipCtx, allArtifacts, summaryLine);
      } catch (e) {
        tell(ctx, "error", `submission failed: ${(e as Error).message}`);
        return;
      }

      handleSubmissionReply(reply, {
        sendUserMessage: (text, opts) => pi.sendUserMessage(text, opts),
        notify: (level, message) => tell(ctx, level, message),
      });
      return; // no local apply
    }

    // --- Local-or-rpc-sock flow (submitTo unset, unchanged) ------------------
    const previewBody = oks
      .map((p) => `${p.handler.label} (${p.result.summary})\n\n${p.result.preview}`)
      .join("\n\n---\n\n");

    const ok = await requestHumanApproval(ctx, pi, {
      title: `Apply pending changes?  (${summaryLine})`,
      summary: summaryLine,
      preview: previewBody,
    });
    if (!ok) {
      tell(ctx, "info", "deferred batch cancelled, nothing applied");
      return;
    }

    for (const p of oks) {
      try {
        const r = await p.result.apply();
        if (r.failed.length > 0) {
          tell(ctx, "error", `${p.handler.label} failures:\n${r.failed.join("\n")}`);
        }
        if (r.wrote.length > 0) {
          tell(ctx, "info", `${p.handler.label} applied:\n${r.wrote.join("\n")}`);
        }
      } catch (e) {
        tell(ctx, "error", `${p.handler.label} crashed: ${(e as Error).message}`);
      }
    }
  });
}
