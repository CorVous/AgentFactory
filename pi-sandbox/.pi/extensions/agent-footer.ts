// agent-footer — replaces pi's default footer with one that fits the
// `npm run agent` rails:
//   line 1, left:  the sandbox scratch root (home replaced by ~).
//   line 1, right: comma-separated active tools from pi.getActiveTools()
//                  — `delegate` hidden because the agents-it-can-spawn
//                  list on line 2 already conveys delegation capability.
//   line 2 (opt):  skills list on the left, agent delegation list on
//                  the right. Both read from getHabitat(). Skipped when
//                  both are empty.
//   line 3, left:  `<bar>| $cost` — 5-cell context-usage bar + cost.
//   line 3, right: model id.
//   line 4 (opt):  extension status texts.

import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { renderBar } from "./_lib/context-bar";
import { getHabitat } from "./_lib/habitat";

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

const HIDDEN_TOOLS = new Set(["delegate"]);

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
    let scratchRoot = path.resolve(ctx.cwd);
    let skills: string[] = [];
    let agents: string[] = [];
    try {
      const h = getHabitat();
      scratchRoot = path.resolve(h.scratchRoot);
      skills = h.skills;
      agents = h.agents;
    } catch {
      // Habitat not available; fall back to ctx.cwd with empty lists.
    }
    const displayRoot = homeReplace(scratchRoot);

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
        const lines = [pwdLine];

        if (skills.length > 0 || agents.length > 0) {
          const composedLine = renderLeftRight(width, skills.join(", "), agents.join(", "), "…");
          lines.push(truncateToWidth(theme.fg("dim", composedLine), width, theme.fg("dim", "...")));
        }

        lines.push(dimLeft + dimRest);

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
