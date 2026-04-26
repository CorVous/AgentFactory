// sandbox-footer.ts — replaces pi's default footer pwd line
// (cwd · git branch · session name) with the sandbox root path,
// since the AgentFactory git branch is irrelevant to whatever
// agent the user is running and the cwd is always the sandbox.
//
// Auto-discovered when pi runs from `pi-sandbox/` (every
// `npm run pi` / `npm run agent:i` entry point). Only attaches in
// interactive mode; print/RPC/json runs have no TUI to override
// (`hasUI === false`) so the handler returns early.
//
// Stats line and extension-status line are preserved (mirroring
// dist/modes/interactive/components/footer.js) — only the first
// line is replaced.

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    const home = process.env.HOME || process.env.USERPROFILE;
    const root = ctx.cwd;
    const display = home && root.startsWith(home)
      ? `~${root.slice(home.length)}`
      : root;
    const sandboxLine = `sandbox: ${display}`;

    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        let totalInput = 0;
        let totalOutput = 0;
        let totalCost = 0;
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            const m = entry.message as AssistantMessage;
            totalInput += m.usage.input;
            totalOutput += m.usage.output;
            totalCost += m.usage.cost.total;
          }
        }

        const statsParts: string[] = [];
        if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
        if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
        if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);
        const left = statsParts.join(" ");
        const right = ctx.model?.id || "no-model";

        const leftWidth = visibleWidth(left);
        const rightWidth = visibleWidth(right);
        const minPadding = 2;
        let statsLine: string;
        if (leftWidth + minPadding + rightWidth <= width) {
          const padding = " ".repeat(width - leftWidth - rightWidth);
          statsLine = left + padding + right;
        } else {
          statsLine = truncateToWidth(left, width, "...");
        }

        const lines = [
          truncateToWidth(theme.fg("dim", sandboxLine), width, theme.fg("dim", "...")),
          theme.fg("dim", statsLine),
        ];

        const statuses = footerData.getExtensionStatuses();
        if (statuses.size > 0) {
          const sorted = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitizeStatusText(text));
          lines.push(
            truncateToWidth(sorted.join(" "), width, theme.fg("dim", "...")),
          );
        }

        return lines;
      },
    }));
  });
}
