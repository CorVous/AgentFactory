// Sandbox extension — baseline rail for every agent launched via
// `npm run agent`. Disables `bash` outright and rejects any tool call
// whose `path` argument resolves outside the sandbox root.
//
// Coverage is discovered at session_start: we walk pi.getAllTools() and
// classify every tool whose schema declares `path: string` as
// path-bearing. The static fallback below is a safety net for the
// installed pi 0.69 built-ins; introspection automatically picks up
// custom tools (including deferred_write) and any future built-ins.
//
// Sandbox root is read from AGENT_SANDBOX_ROOT (set by scripts/run-agent.mjs)
// and falls back to ctx.cwd. The runner spawns pi with cwd = sandbox root,
// so a missing/empty `path` (which the built-in tools resolve to ".") is
// always inside the root.
//
// The extension also installs a custom footer that replaces pi's default
// `cwd (branch)` line with `sandbox: <root>` so the user sees the
// confined directory rather than the host cwd / git branch (which the
// agent cannot escape anyway). The remaining footer lines (token stats,
// model, extension statuses) mirror the default footer.

import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const STATIC_PATH_TOOLS = ["read", "write", "edit", "ls", "grep", "find"];

function declaresPathString(parameters: unknown): boolean {
  try {
    const p = parameters as { type?: string; properties?: Record<string, { type?: string }> };
    return p?.type === "object" && p?.properties?.path?.type === "string";
  } catch {
    return false;
  }
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function homeReplace(p: string): string {
  const home = os.homedir();
  if (!home) return p;
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
  return p;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
  const pathTools = new Set<string>(STATIC_PATH_TOOLS);

  pi.on("session_start", async (_event, ctx) => {
    try {
      for (const tool of pi.getAllTools()) {
        if (declaresPathString(tool.parameters)) pathTools.add(tool.name);
      }
    } catch (e) {
      ctx.ui.notify(
        `sandbox: tool introspection failed (${(e as Error).message}); using static fallback`,
        "warning",
      );
    }

    const root = path.resolve(process.env.AGENT_SANDBOX_ROOT || ctx.cwd);
    const displayRoot = homeReplace(root);
    ctx.ui.notify(`sandbox active: fs limited to ${root}, bash disabled`, "info");
    if (process.env.AGENT_DEBUG === "1") {
      const dump = `sandbox pathTools = [${[...pathTools].sort().join(", ")}]`;
      ctx.ui.notify(dump, "info");
      process.stderr.write(`[AGENT_DEBUG] ${dump}\n`);
    }

    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        const pwdLine = truncateToWidth(
          theme.fg("dim", `sandbox: ${displayRoot}`),
          width,
          theme.fg("dim", "..."),
        );

        let input = 0;
        let output = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        let cost = 0;
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            const u = (entry.message as AssistantMessage).usage;
            input += u.input;
            output += u.output;
            cacheRead += u.cacheRead;
            cacheWrite += u.cacheWrite;
            cost += u.cost.total;
          }
        }

        const usage = ctx.getContextUsage();
        const ctxWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const ctxPct = usage?.percent;

        const stats: string[] = [];
        if (input) stats.push(`↑${formatTokens(input)}`);
        if (output) stats.push(`↓${formatTokens(output)}`);
        if (cacheRead) stats.push(`R${formatTokens(cacheRead)}`);
        if (cacheWrite) stats.push(`W${formatTokens(cacheWrite)}`);
        if (cost) stats.push(`$${cost.toFixed(3)}`);

        const ctxStr =
          typeof ctxPct === "number"
            ? `${ctxPct.toFixed(1)}%/${formatTokens(ctxWindow)}`
            : `?/${formatTokens(ctxWindow)}`;
        let ctxColored = ctxStr;
        if (typeof ctxPct === "number") {
          if (ctxPct > 90) ctxColored = theme.fg("error", ctxStr);
          else if (ctxPct > 70) ctxColored = theme.fg("warning", ctxStr);
        }
        stats.push(ctxColored);

        const left = stats.join(" ");
        const right = ctx.model?.id || "no-model";
        const leftW = visibleWidth(left);
        const rightW = visibleWidth(right);
        const minPad = 2;

        let statsLine: string;
        if (leftW + minPad + rightW <= width) {
          statsLine = left + " ".repeat(width - leftW - rightW) + right;
        } else if (leftW + minPad < width) {
          const truncR = truncateToWidth(right, width - leftW - minPad, "");
          const padW = Math.max(0, width - leftW - visibleWidth(truncR));
          statsLine = left + " ".repeat(padW) + truncR;
        } else {
          statsLine = truncateToWidth(left, width, "...");
        }

        // The context-percent color emits a reset that would clear an outer
        // dim wrapper, so dim the pre-color portion and the remainder separately.
        const dimLeft = theme.fg("dim", left);
        const dimRest = theme.fg("dim", statsLine.slice(left.length));
        const lines = [pwdLine, dimLeft + dimRest];

        const statuses = footerData.getExtensionStatuses();
        if (statuses.size > 0) {
          const sorted = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, t]) => sanitizeStatusText(t));
          lines.push(truncateToWidth(sorted.join(" "), width, theme.fg("dim", "...")));
        }

        return lines;
      },
    }));
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      return { block: true, reason: "bash is disabled in this sandbox" };
    }

    if (!pathTools.has(event.toolName)) return undefined;

    const root = path.resolve(process.env.AGENT_SANDBOX_ROOT || ctx.cwd);
    const input = event.input as Record<string, unknown>;
    const raw = input.path;
    if (raw !== undefined && typeof raw !== "string") return undefined;
    const target = typeof raw === "string" && raw.length > 0 ? raw : ".";
    const resolved = path.resolve(root, target);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return {
        block: true,
        reason: `${event.toolName}: path "${target}" escapes sandbox root ${root}`,
      };
    }
    return undefined;
  });
}
