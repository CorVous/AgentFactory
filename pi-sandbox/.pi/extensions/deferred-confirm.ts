// deferred-confirm extension. Auto-loaded as a baseline extension.
//
// Doubles as:
//   1. A shared registry (the named exports below) that other "deferred-*"
//      extensions import to register end-of-turn handlers.
//   2. The coordinator that, on agent_end, drives every registered handler
//      through prepare -> unified ctx.ui.confirm -> atomic apply.
//
// The handler array is stashed on globalThis so it's shared across
// extensions even though jiti loads each extension's import graph in
// isolation (loader.js uses `moduleCache: false` and a fresh createJiti
// per extension).

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
      if (ctx.hasUI) {
        ctx.ui.notify(
          `deferred batch aborted (re-validation failed):\n${errors.join("\n")}`,
          "error",
        );
      }
      return;
    }

    type OkEntry = { handler: DeferredHandler; result: Extract<PrepareResult, { status: "ok" }> };
    const oks: OkEntry[] = prepared.flatMap((p) =>
      p.result.status === "ok" ? [{ handler: p.handler, result: p.result }] : [],
    );
    if (oks.length === 0) return;

    if (!ctx.hasUI) {
      // Non-interactive: refuse to apply without confirmation.
      return;
    }

    oks.sort((a, b) => a.handler.priority - b.handler.priority);

    const summaryLine = oks
      .map((p) => `${p.handler.label.toLowerCase()}: ${p.result.summary}`)
      .join(" · ");
    const previewBody = oks
      .map((p) => `${p.handler.label} (${p.result.summary})\n\n${p.result.preview}`)
      .join("\n\n---\n\n");

    const ok = await ctx.ui.confirm(
      `Apply pending changes?  (${summaryLine})`,
      previewBody,
    );
    if (!ok) {
      ctx.ui.notify("deferred batch cancelled, nothing applied", "info");
      return;
    }

    for (const p of oks) {
      try {
        const r = await p.result.apply();
        if (r.failed.length > 0) {
          ctx.ui.notify(`${p.handler.label} failures:\n${r.failed.join("\n")}`, "error");
        }
        if (r.wrote.length > 0) {
          ctx.ui.notify(`${p.handler.label} applied:\n${r.wrote.join("\n")}`, "info");
        }
      } catch (e) {
        ctx.ui.notify(`${p.handler.label} crashed: ${(e as Error).message}`, "error");
      }
    }
  });
}
