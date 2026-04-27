// agent-footer — replaces pi's default footer with one that fits the
// `npm run agent` rails:
//   line 1, left:  the `--sandbox-root` flag value (home replaced by
//                  ~), instead of pi's `cwd (branch)`. The agent can't
//                  escape the sandbox so the host cwd / branch are
//                  misleading noise.
//   line 1, right: comma-separated active tools from pi.getActiveTools()
//                  — the recipe's `tools:` allowlist plus any tools
//                  registered by extensions. `delegate` and
//                  `approve_delegation` are hidden because every
//                  delegating agent has them; they're noise next to
//                  the tools that actually distinguish the recipe.
//                  Truncated with an ellipsis on narrow terminals;
//                  dropped entirely if there is no room for a 2-column
//                  gap after the sandbox path.
//   line 2, left:  `<bar>| $cost` — 5-cell eighths-block context-usage
//                  bar (warning tint > 70%, error tint > 90%), followed
//                  by the accumulated assistant cost from session
//                  history. pi's default token-flow stats (↑input,
//                  ↓output, cache R/W, /<window-size>) are
//                  intentionally dropped.
//   line 2, right: model id.
//   line 3 (opt):  the recipe's `skills:` list on the left and the
//                  recipes this agent may `delegate` to on the right
//                  (comma-separated, no labels — matches line 1's
//                  bare-list style). Read from the PI_AGENT_SKILLS /
//                  PI_AGENT_AGENTS env vars set by the runner
//                  (pi.getFlag is scoped per extension, so
//                  cross-extension flag reads have to bounce through
//                  env, mirroring how agent-status-reporter reads
//                  --rpc-sock). Skipped when both lists are empty.
//   line 4 (opt):  extension status texts set via ctx.ui.setStatus().

import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { renderBar } from "./_lib/context-bar";

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

// Tools that every delegating agent gets via the implicit-wire in
// run-agent.mjs. Always-on tools tell the user nothing about the
// recipe, so we drop them from the line-1 tool list — agents-it-can-
// spawn is conveyed on line 3 instead.
const HIDDEN_TOOLS = new Set(["delegate", "approve_delegation"]);

function parseEnvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function renderLeftRight(
  width: number,
  left: string,
  right: string,
  truncIndicator: string,
): string {
  const lW = visibleWidth(left);
  const rW = visibleWidth(right);
  const minGap = 2;
  if (lW === 0 && rW === 0) return "";
  if (lW === 0) {
    if (rW <= width) return " ".repeat(width - rW) + right;
    return truncateToWidth(right, width, truncIndicator);
  }
  if (rW === 0) {
    return truncateToWidth(left, width, truncIndicator);
  }
  if (lW + minGap + rW <= width) {
    return left + " ".repeat(width - lW - rW) + right;
  }
  if (lW + minGap < width) {
    const truncR = truncateToWidth(right, width - lW - minGap, truncIndicator);
    const padW = Math.max(0, width - lW - visibleWidth(truncR));
    return left + " ".repeat(padW) + truncR;
  }
  return truncateToWidth(left, width, truncIndicator);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const root = path.resolve((pi.getFlag("sandbox-root") as string | undefined) || ctx.cwd);
    const displayRoot = homeReplace(root);
    const skills = parseEnvList(process.env.PI_AGENT_SKILLS);
    const agents = parseEnvList(process.env.PI_AGENT_AGENTS);

    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        const sandboxLabel = displayRoot;
        let activeTools: string[] = [];
        try {
          activeTools = pi.getActiveTools();
        } catch {
          // getActiveTools may not be ready in some session states.
        }
        const visibleTools = activeTools.filter((t) => !HIDDEN_TOOLS.has(t));
        const toolsLabel = visibleTools.length > 0 ? visibleTools.join(", ") : "";
        const pwdContent = renderLeftRight(width, sandboxLabel, toolsLabel, "…");
        const pwdLine = truncateToWidth(theme.fg("dim", pwdContent), width, theme.fg("dim", "..."));

        let cost = 0;
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            cost += (entry.message as AssistantMessage).usage.cost.total;
          }
        }

        const ctxPct = ctx.getContextUsage()?.percent;

        const ctxStr = typeof ctxPct === "number" ? renderBar(ctxPct, 5) : "?";
        let ctxColored = ctxStr;
        if (typeof ctxPct === "number") {
          if (ctxPct > 90) ctxColored = theme.fg("error", ctxStr);
          else if (ctxPct > 70) ctxColored = theme.fg("warning", ctxStr);
        }

        const stats: string[] = [ctxColored];
        if (cost) stats.push(`$${cost.toFixed(3)}`);

        const left = stats.join("| ");
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

        if (skills.length > 0 || agents.length > 0) {
          const composedLine = renderLeftRight(width, skills.join(", "), agents.join(", "), "…");
          lines.push(truncateToWidth(theme.fg("dim", composedLine), width, theme.fg("dim", "...")));
        }

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
