// deferred-confirm extension. Auto-loaded as a baseline extension.
//
// Doubles as:
//   1. A shared registry (the named exports below) that other "deferred-*"
//      extensions import to register end-of-turn handlers.
//   2. The coordinator that, on agent_end, drives every registered handler
//      through prepare -> unified approval prompt -> atomic apply.
//   3. The owner of the RPC primitive that lets a print-mode child forward
//      its approval request to its parent's UI. Same primitive is used by
//      agent-spawn's `approve_delegation` escalation path, so any agent
//      works whether it's running standalone (with a UI) or as a child
//      (with --rpc-sock), and escalations bubble recursively up the
//      parent chain to whoever has a real UI.
//
// The handler array is stashed on globalThis so it's shared across
// extensions even though jiti loads each extension's import graph in
// isolation (loader.js uses `moduleCache: false` and a fresh createJiti
// per extension).

import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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
    };

export interface ApprovalRequest {
  title: string;
  summary: string;
  preview: string;
}

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

/**
 * Recursive approval primitive. Routes a request to whoever can answer:
 *   - if ctx.hasUI, render ctx.ui.confirm locally (this process is the human's terminal)
 *   - else if --rpc-sock is set, forward to the parent agent's RPC server
 *     (parent itself recurses if it's also headless, so escalation walks
 *     up the chain to the human at the top)
 *   - else loud-fail to stderr and return false
 *
 * Used by deferred-confirm's own agent_end and by agent-spawn's
 * approve_delegation when the parent LLM chooses to escalate.
 */
export async function requestHumanApproval(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  req: ApprovalRequest,
): Promise<boolean> {
  if (ctx.hasUI) {
    return ctx.ui.confirm(req.title, req.preview);
  }
  const sockPath = pi.getFlag("rpc-sock") as string | undefined;
  if (sockPath) {
    return rpcRequestApproval(sockPath, req);
  }
  process.stderr.write(
    `[deferred] dropped: no UI and no --rpc-sock (title: ${req.title})\n`,
  );
  return false;
}

/**
 * Connect to the parent's RPC server, send one request, await one reply.
 * Any failure (parent died, EPIPE, malformed reply, server closed without
 * replying) settles as approved=false. No retries, no offline queueing.
 */
function rpcRequestApproval(sockPath: string, req: ApprovalRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    let buf = "";
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(approved);
    };
    sock.setEncoding("utf8");
    sock.once("connect", () => {
      const line = JSON.stringify({ type: "request-approval", ...req }) + "\n";
      sock.write(line, "utf8", (err?: Error | null) => {
        if (err) settle(false);
      });
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      try {
        const msg = JSON.parse(line) as { type?: string; approved?: unknown };
        if (msg.type === "approval-result" && typeof msg.approved === "boolean") {
          settle(msg.approved);
          return;
        }
      } catch {
        /* fall through to false */
      }
      settle(false);
    });
    sock.once("error", () => settle(false));
    sock.once("close", () => settle(false));
  });
}

/**
 * Route an info/error notification through the right channel.
 * If we have a UI, use ctx.ui.notify; otherwise write a tagged line to
 * stdout so the parent's tool-call result captures it.
 */
function tell(ctx: ExtensionContext, level: "info" | "error", message: string) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  const tag = level === "error" ? "[deferred:error]" : "[deferred]";
  process.stdout.write(`${tag} ${message}\n`);
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("rpc-sock", {
    description:
      "Unix socket path used to forward end-of-turn approval requests to a parent agent. " +
      "Set by agent-spawn when launching a child; leave unset for interactive runs.",
    type: "string",
  });

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
