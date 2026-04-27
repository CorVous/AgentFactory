// agent-view — slash commands and TUI plumbing for "switching into" a
// delegated child agent.
//
// Commands:
//   /view <prefix>   Enter view mode for the matching pending delegation.
//                    The child name is matched against entry.agentName
//                    (the <breed>-<shortName> slug from agent-naming).
//                    Exact match wins; otherwise unique case-insensitive
//                    prefix; otherwise notify the user with the
//                    candidates.
//   /back   (alias /unview)  Exit view mode and release the child so it
//                            can exit at its next agent_end.
//
// While in view mode:
//   - The viewer widget at "aboveEditor" renders the child's live
//     transcript (last N lines, sized to the visible terminal).
//   - Approvals from the child (request-approval over RPC) are routed
//     to ctx.ui.confirm in the parent's terminal instead of being
//     queued for the foreman LLM. The interceptor is registered on
//     globalThis.__pi_view_interceptor__ for agent-spawn to find.
//   - Anything the human types into the input editor is forwarded to
//     the child as `{type: "user-message", body}` over its control
//     conn, and pi is told the input was handled (it does NOT become
//     a parent-LLM turn). The forwarded text is echoed into the
//     viewer transcript so the user sees their own messages.
//   - When the user enters /view, the parent sends `start-takeover` to
//     the child so the child stays alive past natural turn-end. /back
//     sends `release` and the child exits at the next agent_end.
//   - If the viewed child exits unexpectedly (timeout, crash), the
//     viewer auto-exits and notifies the user.
//
// All cross-extension wiring is via globalThis (delegate registry,
// invalidate hook, view interceptor, send-to-child helper) — same
// pattern as agent-spawn / delegation-boxes / hide-extensions-list,
// because jiti's per-extension module isolation breaks plain
// cross-imports.

import net from "node:net";
import type { ExtensionAPI, ExtensionCommandContext, InputEventResult } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { prettify } from "./_lib/agent-naming";

const TRANSCRIPT_MAX_BYTES = 64 * 1024;
const VIEWER_MIN_LINES = 6;
const VIEWER_MAX_LINES = 40;

interface DelegationStatus {
  receivedAt: number;
  agentName: string;
  modelId: string;
  contextPct: number;
  contextTokens: number;
  contextWindow: number;
  costUsd: number;
  turnCount: number;
  state: "running" | "paused" | "settled";
}

interface PendingEntry {
  id: string;
  recipe: string;
  agentName?: string;
  startedAt: number;
  resolvedConn?: net.Socket;
  pendingApprovalReq?: { title: string; summary: string; preview: string };
  controlConn?: net.Socket;
  streamSubscribers: Set<(chunk: string, kind: "stdout" | "stderr") => void>;
  lastStatus?: DelegationStatus;
  exited?: Promise<unknown>;
}

interface SpawnRegistry {
  pending: Map<string, PendingEntry>;
}

function getRegistry(): SpawnRegistry | undefined {
  return (globalThis as { __pi_delegate_pending__?: SpawnRegistry }).__pi_delegate_pending__;
}

function getSendToChild(): ((id: string, envelope: Record<string, unknown>) => boolean) | undefined {
  return (globalThis as { __pi_delegate_send__?: (id: string, e: Record<string, unknown>) => boolean }).__pi_delegate_send__;
}

function notifyWidget(): void {
  try {
    (globalThis as { __pi_delegate_invalidate__?: () => void }).__pi_delegate_invalidate__?.();
  } catch {
    /* noop */
  }
}

// Duck-typed theme — matches the subset of @mariozechner/pi-coding-agent's
// Theme class that we actually call. Importing the concrete class would
// drag in the interactive-mode bundle and the codebase already uses this
// pattern in delegation-boxes.ts.
type ThemeColor = "accent" | "dim" | "warning" | "error";
interface Theme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

interface ViewState {
  id: string;
  agentName: string;
  // Bounded ring buffer of transcript text. We don't try to parse
  // pi's print-mode output structure; raw text is good enough to
  // watch what the child is doing.
  transcript: string;
  unsubscribe: () => void;
}

let viewing: ViewState | null = null;

function appendTranscript(text: string): void {
  if (!viewing) return;
  viewing.transcript += text;
  if (viewing.transcript.length > TRANSCRIPT_MAX_BYTES) {
    // Drop the oldest half so the buffer doesn't grow unbounded over
    // long takeovers. We render only the last N lines anyway, so
    // dropping ancient history is invisible.
    viewing.transcript = viewing.transcript.slice(-Math.floor(TRANSCRIPT_MAX_BYTES / 2));
  }
  notifyWidget();
}

function findEntry(query: string): { entry: PendingEntry; matches?: string[] } | { error: string } {
  const reg = getRegistry();
  if (!reg || reg.pending.size === 0) {
    return { error: "no pending delegations" };
  }
  const q = query.trim().toLowerCase();
  if (!q) return { error: "usage: /view <agent-name-or-prefix>" };

  const all = Array.from(reg.pending.values());
  // Exact match (case-insensitive) on agentName wins outright.
  const exact = all.find((e) => (e.agentName ?? "").toLowerCase() === q);
  if (exact) return { entry: exact };

  // Otherwise prefix match, case-insensitive. Substring fallback if
  // no prefix matches — handy when the user remembers part of the
  // breed but not its position.
  const prefix = all.filter((e) => (e.agentName ?? "").toLowerCase().startsWith(q));
  const candidates = prefix.length > 0 ? prefix : all.filter((e) => (e.agentName ?? "").toLowerCase().includes(q));
  if (candidates.length === 0) {
    return { error: `no delegation matches '${query}'. pending: ${all.map((e) => e.agentName ?? e.recipe).join(", ")}` };
  }
  if (candidates.length > 1) {
    return { error: `ambiguous: ${candidates.map((e) => e.agentName ?? e.recipe).join(", ")}` };
  }
  return { entry: candidates[0]! };
}

function exitViewMode(): void {
  if (!viewing) return;
  const v = viewing;
  viewing = null;
  try {
    v.unsubscribe();
  } catch {
    /* noop */
  }
  // Best-effort release. If the entry is gone (child already exited)
  // sendToChild returns false silently, which is fine.
  const send = getSendToChild();
  send?.(v.id, { type: "release" });
  notifyWidget();
}

function startViewMode(entry: PendingEntry): void {
  // Switching from an existing view: tear down the old one first.
  if (viewing) {
    if (viewing.id === entry.id) return; // already viewing this one
    exitViewMode();
  }

  const sub = (chunk: string, _kind: "stdout" | "stderr") => {
    appendTranscript(chunk);
  };
  entry.streamSubscribers.add(sub);

  viewing = {
    id: entry.id,
    agentName: entry.agentName ?? entry.recipe,
    // Seed with already-captured stdout so the user sees what they
    // missed before opening the viewer.
    transcript: "",
    unsubscribe: () => entry.streamSubscribers.delete(sub),
  };

  // Park the child at agent_end so it doesn't exit while we're
  // watching. agent-receive sets `released = false`; without this the
  // child would exit at its next natural turn boundary and the user
  // would lose their view immediately after the first response.
  const send = getSendToChild();
  send?.(entry.id, { type: "start-takeover" });

  notifyWidget();
}

// Render a 4-cell context bar matching delegation-boxes' style, but
// inline with the header line.
function renderHeaderLine(theme: Theme, entry: PendingEntry, width: number): string {
  const status = entry.lastStatus;
  const name = prettify(entry.agentName ?? entry.recipe);
  const state = status?.state ?? "running";
  const stateColored =
    state === "paused"
      ? theme.fg("warning", state)
      : state === "settled"
        ? theme.fg("dim", state)
        : theme.fg("accent", state);
  const pct = status?.contextPct ?? 0;
  const cost = status?.costUsd ?? 0;
  const turn = status?.turnCount ?? 0;
  const stats = `ctx ${pct.toFixed(0)}% · $${cost.toFixed(4)} · turn ${turn}`;
  const head = theme.bold(theme.fg("accent", `▶ ${name}`));
  const body = `${head}  ${stateColored}  ${theme.fg("dim", stats)}`;
  // Truncate-to-width prevents wrap; visibleWidth ignores ANSI.
  if (visibleWidth(body) > width) return truncateToWidth(body, width, "…");
  return body;
}

function lastLines(text: string, max: number): string[] {
  if (max <= 0) return [];
  // Pi's print-mode output uses raw \n. Strip CR for terminals that
  // emit \r\n; the renderer will add its own line breaks.
  const lines = text.replace(/\r/g, "").split("\n");
  return lines.slice(-max);
}

function wrapToWidth(line: string, width: number): string[] {
  if (width <= 0) return [line];
  if (visibleWidth(line) <= width) return [line];
  // Pi's print-mode output is mostly plain text. For oversized lines,
  // keep the most recent prefix (truncated) — losing the tail is fine
  // since the next render shows the next chunk and we never store
  // ANSI-spanning lines anyway. Doing proper ANSI-aware wrap would
  // need a full state machine; for the viewer's purposes a single
  // truncated line per logical line is good enough.
  return [truncateToWidth(line, width, "…")];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Install the approval interceptor. agent-spawn calls this from
    // its RPC `request-approval` handler when the child is the one
    // we're currently viewing.
    (globalThis as { __pi_view_interceptor__?: (id: string, conn: net.Socket, req: { title: string; summary: string; preview: string }) => Promise<boolean> }).__pi_view_interceptor__ =
      async (id, conn, req) => {
        if (!viewing || viewing.id !== id) return false;
        appendTranscript(`\n── approval request ─────────────────\n${req.title}\n${req.preview}\n`);
        const approved = await ctx.ui.confirm(req.title, req.preview);
        try {
          conn.write(JSON.stringify({ type: "approval-result", approved }) + "\n");
        } catch {
          /* child died mid-decision; not much we can do */
        }
        appendTranscript(`── ${approved ? "approved" : "rejected"} ─────────────\n\n`);
        // If the entry stashed this same request as "pending" (parent
        // saw the request before the user entered view mode), clear
        // it so a subsequent /view doesn't re-pop the dialog.
        const reg = getRegistry();
        const entry = reg?.pending.get(id);
        if (entry) entry.pendingApprovalReq = undefined;
        return true;
      };

    // The viewer widget. Returns [] when no view is active so it
    // collapses to zero height and doesn't push delegation-boxes off
    // the screen during normal foreman work.
    ctx.ui.setWidget(
      "agent-view",
      // Cast pi's Theme to our duck-typed subset. Same pattern as
      // delegation-boxes.ts which captures the theme via a narrower
      // local interface so we don't have to import the full Theme class.
      (_tui, themeArg) => {
        const theme = themeArg as unknown as Theme;
        return ({
        invalidate() {},
        render(width: number): string[] {
          if (!viewing) return [];
          const reg = getRegistry();
          const entry = reg?.pending.get(viewing.id);
          if (!entry) {
            // Child vanished from the registry (settled + cleaned up).
            // Auto-exit on the next render tick.
            const v = viewing;
            viewing = null;
            try {
              v.unsubscribe();
            } catch {
              /* noop */
            }
            return [theme.fg("dim", `── ${v.agentName} settled · /back to dismiss ──`)];
          }
          const headerLine = renderHeaderLine(theme, entry, width);
          const sep = theme.fg("dim", "─".repeat(width));
          const hint = theme.fg("dim", `/back to release · type to message agent · y/n at approval prompt`);
          const transcriptBudget = Math.max(VIEWER_MIN_LINES, Math.min(VIEWER_MAX_LINES, Math.floor(process.stdout.rows ? process.stdout.rows - 12 : VIEWER_MIN_LINES)));
          const lines = lastLines(viewing.transcript, transcriptBudget);
          const wrapped: string[] = [];
          for (const line of lines) {
            for (const w of wrapToWidth(line, width)) wrapped.push(w);
            if (wrapped.length >= transcriptBudget) break;
          }
          // Pad to a consistent height so the viewer doesn't jump
          // around as the child emits lines.
          while (wrapped.length < transcriptBudget) wrapped.push("");
          return [headerLine, sep, ...wrapped.slice(-transcriptBudget), sep, hint];
        },
        });
      },
      { placement: "aboveEditor" },
    );

    // Forward editor input to the child while in view mode. The
    // {action: "handled"} return tells pi the text is fully consumed
    // — it does NOT become a parent-LLM turn, so the foreman keeps
    // parking on approve_delegation rather than spinning up a new
    // model call.
    pi.on("input", async (event): Promise<InputEventResult> => {
      if (!viewing) return { action: "continue" };
      const text = (event.text || "").trim();
      // Slash commands always pass through so /back, /quit, /reload
      // still work while viewing.
      if (text.startsWith("/")) return { action: "continue" };
      if (!text) return { action: "handled" };

      const send = getSendToChild();
      const ok = send?.(viewing.id, { type: "user-message", body: text }) ?? false;
      if (!ok) {
        ctx.ui.notify(
          `view: child has no control conn — message not delivered. /back to exit.`,
          "warning",
        );
        return { action: "handled" };
      }
      appendTranscript(`\n[you] ${text}\n`);
      return { action: "handled" };
    });
  });

  pi.registerCommand("view", {
    description: "Enter view mode for a delegated child (e.g. /view cottontail-writer).",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const result = findEntry(args);
      if ("error" in result) {
        ctx.ui.notify(`view: ${result.error}`, "warning");
        return;
      }
      const entry = result.entry;
      startViewMode(entry);
      ctx.ui.notify(`viewing ${entry.agentName ?? entry.recipe}`, "info");

      // Scenario C: the child paused before the user entered view
      // mode, so the request-approval was already routed to the
      // foreman path. Pop the dialog now and write the result over
      // the open conn — the foreman's eventual decision will write
      // to a closed conn (silent failure) and that's fine.
      if (entry.pendingApprovalReq && entry.resolvedConn) {
        const req = entry.pendingApprovalReq;
        const conn = entry.resolvedConn;
        entry.pendingApprovalReq = undefined;
        appendTranscript(`\n── pending approval (carried over) ──\n${req.title}\n${req.preview}\n`);
        const approved = await ctx.ui.confirm(req.title, req.preview);
        try {
          conn.write(JSON.stringify({ type: "approval-result", approved }) + "\n");
        } catch {
          /* child may have already moved on / died */
        }
        appendTranscript(`── ${approved ? "approved" : "rejected"} ──\n\n`);
      }
    },
  });

  // pi's RegisteredCommand interface doesn't expose `aliases:`, so
  // register /back and /unview as twin commands sharing one handler.
  const backHandler = async (_args: string, ctx: ExtensionCommandContext) => {
    if (!viewing) {
      ctx.ui.notify("view: not currently viewing anything", "info");
      return;
    }
    const name = viewing.agentName;
    exitViewMode();
    ctx.ui.notify(`released ${name}`, "info");
  };
  pi.registerCommand("back", {
    description: "Exit view mode and release the child so it exits at its next turn boundary.",
    handler: backHandler,
  });
  pi.registerCommand("unview", {
    description: "Alias for /back.",
    handler: backHandler,
  });

  // Tear down on session shutdown so the global doesn't leak across
  // /reload cycles.
  pi.on("session_shutdown", async () => {
    if (viewing) exitViewMode();
    delete (globalThis as { __pi_view_interceptor__?: unknown }).__pi_view_interceptor__;
  });
}
