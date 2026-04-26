// agent-footer — replaces pi's default footer with one that fits the
// `npm run agent` rails:
//   line 1, left:  `sandbox: <root>` (the `--sandbox-root` flag value,
//                  with home replaced by ~), instead of pi's `cwd (branch)`. The
//                  agent can't escape the sandbox so the host cwd /
//                  branch are misleading noise.
//   line 1, right: `tools: <name1, name2, ...>` from pi.getActiveTools(),
//                  i.e. the recipe's `tools:` allowlist plus any tools
//                  registered by extensions. Truncated with an ellipsis
//                  on narrow terminals; dropped entirely if there is no
//                  room for a 2-column gap after the sandbox label.
//   line 2:        token stats + context % + model id (mirrors pi's
//                  default).
//   line 3 (opt):  extension status texts set via ctx.ui.setStatus().

import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

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
  pi.on("session_start", async (_event, ctx) => {
    const root = path.resolve((pi.getFlag("sandbox-root") as string | undefined) || ctx.cwd);
    const displayRoot = homeReplace(root);

    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        const sandboxLabel = `sandbox: ${displayRoot}`;
        let activeTools: string[] = [];
        try {
          activeTools = pi.getActiveTools();
        } catch {
          // getActiveTools may not be ready in some session states.
        }
        const toolsLabel = activeTools.length > 0 ? `tools: ${activeTools.join(", ")}` : "";
        const sbW = visibleWidth(sandboxLabel);
        const tlW = visibleWidth(toolsLabel);
        const minGap = 2;

        let pwdContent: string;
        if (toolsLabel.length > 0 && sbW + minGap + tlW <= width) {
          pwdContent = sandboxLabel + " ".repeat(width - sbW - tlW) + toolsLabel;
        } else if (toolsLabel.length > 0 && sbW + minGap < width) {
          const truncT = truncateToWidth(toolsLabel, width - sbW - minGap, "…");
          pwdContent = sandboxLabel + " ".repeat(Math.max(0, width - sbW - visibleWidth(truncT))) + truncT;
        } else {
          pwdContent = sandboxLabel;
        }
        const pwdLine = truncateToWidth(theme.fg("dim", pwdContent), width, theme.fg("dim", "..."));

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
}
