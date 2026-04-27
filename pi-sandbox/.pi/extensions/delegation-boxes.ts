// delegation-boxes — parent-side widget that renders a status box per
// pending delegation, above the input editor. Composes with agent-spawn
// (which owns the registry at globalThis.__pi_delegate_pending__) and
// agent-status-reporter (which pushes child stats over the per-call RPC
// socket). When no delegations are active the widget collapses to zero
// height. Wraps to 2 boxes per row by default, 3 on terminals ≥ 120
// columns wide.
//
// Re-render is triggered by agent-spawn calling
// globalThis.__pi_delegate_invalidate__ whenever it caches a fresh
// status snapshot or when an entry settles. The factory captures the
// TUI instance and exposes its requestRender via that global.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { renderBar } from "./_lib/context-bar";

const BAR_CELLS = 3;

type DelegationState = "running" | "paused" | "settled";

interface LastStatus {
  receivedAt: number;
  agentName: string;
  modelId: string;
  contextPct: number;
  contextTokens: number;
  contextWindow: number;
  costUsd: number;
  turnCount: number;
  state: DelegationState;
}

interface PendingEntry {
  id: string;
  recipe: string;
  startedAt: number;
  lastStatus?: LastStatus;
}

interface SpawnRegistry {
  pending: Map<string, PendingEntry>;
}

function getRegistry(): SpawnRegistry | undefined {
  return (globalThis as { __pi_delegate_pending__?: SpawnRegistry }).__pi_delegate_pending__;
}

function pickCols(width: number, count: number): number {
  if (count <= 0) return 1;
  if (width >= 120 && count >= 3) return 3;
  if (width >= 60 && count >= 2) return 2;
  return 1;
}

interface Theme {
  fg(level: "accent" | "dim" | "warning" | "error" | "info", text: string): string;
  bold(text: string): string;
}

function colorBar(theme: Theme, bar: string, pct: number): string {
  if (pct > 90) return theme.fg("error", bar);
  if (pct > 70) return theme.fg("warning", bar);
  return bar;
}

function colorState(theme: Theme, state: DelegationState): string {
  if (state === "paused") return theme.fg("warning", "paused");
  if (state === "settled") return theme.fg("dim", "settled");
  return theme.fg("accent", "running");
}

// Rounded-border box, 4 lines tall. boxWidth is the visible width of
// every line (including the corners). Returns exactly 4 strings.
function renderBox(theme: Theme, entry: PendingEntry, boxWidth: number): string[] {
  const inner = boxWidth - 2; // between the corners
  const status = entry.lastStatus;
  const name = entry.recipe;
  const modelId = status?.modelId ?? "";
  const pct = status?.contextPct ?? 0;
  const cost = status?.costUsd ?? 0;
  const turn = status?.turnCount ?? 0;
  const state: DelegationState = status?.state ?? "running";

  // --- Line 1: ╭ name ──── bar ╮ ---
  // Budget inside the corners: " " + name + " " + dashes + " " + bar + " "
  // dashWidth = inner - 4 (four spaces) - nameWidth - barWidth
  let nameMax = inner - 4 - 1 - BAR_CELLS; // need at least 1 dash
  if (nameMax < 3) nameMax = Math.max(0, inner - 4 - BAR_CELLS);
  const nameTrunc = truncateToWidth(name, nameMax, "…");
  const nameW = visibleWidth(nameTrunc);
  let dashCount = inner - 4 - nameW - BAR_CELLS;
  if (dashCount < 1) dashCount = 1;
  const bar = renderBar(pct, BAR_CELLS);
  const coloredBar = colorBar(theme, bar, pct);
  const top =
    theme.fg("dim", "╭") +
    " " +
    theme.bold(theme.fg("accent", nameTrunc)) +
    " " +
    theme.fg("dim", "─".repeat(dashCount)) +
    " " +
    coloredBar +
    " " +
    theme.fg("dim", "╮");

  // --- Line 2: │ model id (padded) │ ---
  const modelMax = inner - 2;
  const modelTrunc = truncateToWidth(modelId, modelMax, "…");
  const modelPad = " ".repeat(Math.max(0, modelMax - visibleWidth(modelTrunc)));
  const line2 =
    theme.fg("dim", "│") +
    " " +
    theme.fg("dim", modelTrunc) +
    modelPad +
    " " +
    theme.fg("dim", "│");

  // --- Line 3: │ $cost · turn N · state (padded) │ ---
  const costStr = `$${cost.toFixed(4)}`;
  const turnStr = `turn ${turn}`;
  const stateColored = colorState(theme, state);
  const stateRaw = state; // for width math
  const sep = " · ";
  // Visible width of the assembled content.
  const contentW = visibleWidth(costStr) + visibleWidth(sep) + visibleWidth(turnStr) + visibleWidth(sep) + visibleWidth(stateRaw);
  let assembled =
    theme.bold(costStr) +
    theme.fg("dim", sep) +
    turnStr +
    theme.fg("dim", sep) +
    stateColored;
  const stateMax = inner - 2;
  if (contentW > stateMax) {
    // Drop turn segment; if still too wide, drop cost precision.
    const compactCost = `$${cost.toFixed(2)}`;
    const compactW = visibleWidth(compactCost) + visibleWidth(sep) + visibleWidth(stateRaw);
    if (compactW <= stateMax) {
      assembled = theme.bold(compactCost) + theme.fg("dim", sep) + stateColored;
    } else {
      assembled = stateColored;
    }
  }
  const finalW = visibleWidth(assembled.replace(/\x1b\[[0-9;]*m/g, ""));
  const pad = " ".repeat(Math.max(0, stateMax - finalW));
  const line3 = theme.fg("dim", "│") + " " + assembled + pad + " " + theme.fg("dim", "│");

  // --- Line 4: bottom border ---
  const bottom = theme.fg("dim", "╰" + "─".repeat(inner) + "╯");

  return [top, line2, line3, bottom];
}

function joinBoxesRow(boxes: string[][], boxWidth: number, gap: string): string[] {
  // Each box has 4 lines; zip them.
  const rows: string[] = [];
  for (let line = 0; line < 4; line++) {
    const parts: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      const cell = b[line] ?? " ".repeat(boxWidth);
      parts.push(cell);
    }
    rows.push(parts.join(gap));
  }
  return rows;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    let cachedTui: Component | undefined;

    const factory = (tui: Component) => {
      cachedTui = tui;
      (globalThis as { __pi_delegate_invalidate__?: () => void }).__pi_delegate_invalidate__ = () => {
        try {
          (cachedTui as { requestRender?: () => void } | undefined)?.requestRender?.();
        } catch {
          /* noop */
        }
      };
      return {
        invalidate() {},
        render(width: number): string[] {
          const reg = getRegistry();
          if (!reg || reg.pending.size === 0) return [];
          const entries = Array.from(reg.pending.values());
          const cols = pickCols(width, entries.length);
          const gap = "  ";
          const totalGap = gap.length * (cols - 1);
          const boxWidth = Math.max(20, Math.floor((width - totalGap) / cols));
          const theme = (ctx.ui as { theme: Theme }).theme;

          const lines: string[] = [];
          for (let i = 0; i < entries.length; i += cols) {
            const slice = entries.slice(i, i + cols);
            const boxes = slice.map((e) => renderBox(theme, e, boxWidth));
            lines.push(...joinBoxesRow(boxes, boxWidth, gap));
          }
          return lines;
        },
      };
    };

    ctx.ui.setWidget("delegation-boxes", factory, { placement: "aboveEditor" });
  });
}
