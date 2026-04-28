// status-display — baseline extension that renders a status box per active
// sender above the input editor. Sources data from the StatusCache populated
// by the __pi_status_dispatch__ hook registered here at session_start.
//
// Visual layout (borrowed from the deleted delegation-boxes.ts):
//   ╭ agentName ──── bar ╮
//   │ model-id           │
//   │ $cost · turn N · state │
//   ╰────────────────────╯
//
// 2 boxes per row by default; 3 on terminals ≥ 120 columns.
// Boxes evict after TTL via the cache's lazy eviction on entries().
//
// Self-gates: silently returns without registering any widget or hook
// when `ctx.hasUI` is false (non-interactive / print mode).

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { renderBar } from "./_lib/context-bar";
import { prettify } from "./_lib/agent-naming";
import { createStatusCache } from "./_lib/status-cache";
import type { Envelope } from "./_lib/bus-envelope";

const BAR_CELLS = 3;

type StateKind = "running" | "paused" | "settled";

interface Theme {
  fg(level: "accent" | "dim" | "warning" | "error" | "info", text: string): string;
  bold(text: string): string;
}

function colorBar(theme: Theme, bar: string, pct: number): string {
  if (pct > 90) return theme.fg("error", bar);
  if (pct > 70) return theme.fg("warning", bar);
  return bar;
}

function colorState(theme: Theme, state: StateKind): string {
  if (state === "paused") return theme.fg("warning", "paused");
  if (state === "settled") return theme.fg("dim", "settled");
  return theme.fg("accent", "running");
}

function pickCols(width: number, count: number): number {
  if (count <= 0) return 1;
  if (width >= 120 && count >= 3) return 3;
  if (width >= 60 && count >= 2) return 2;
  return 1;
}

interface BoxEntry {
  agentName: string;
  modelId: string;
  contextPct: number;
  costUsd: number;
  turnCount: number;
  state: StateKind;
}

// Renders a single 4-line rounded-border box. Returns exactly 4 strings.
function renderBox(theme: Theme, entry: BoxEntry, boxWidth: number): string[] {
  const inner = boxWidth - 2;
  const name = prettify(entry.agentName);
  const pct = entry.contextPct;
  const cost = entry.costUsd;
  const turn = entry.turnCount;
  const state = entry.state;

  // Line 1: ╭ name ──── bar ╮
  let nameMax = inner - 4 - 1 - BAR_CELLS; // 4 spaces + 1 dash min + bar
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

  // Line 2: │ model id (padded) │
  const modelMax = inner - 2;
  const modelTrunc = truncateToWidth(entry.modelId, modelMax, "…");
  const modelPad = " ".repeat(Math.max(0, modelMax - visibleWidth(modelTrunc)));
  const line2 =
    theme.fg("dim", "│") +
    " " +
    theme.fg("dim", modelTrunc) +
    modelPad +
    " " +
    theme.fg("dim", "│");

  // Line 3: │ $cost · turn N · state (padded) │
  const costStr = `$${cost.toFixed(4)}`;
  const turnStr = `turn ${turn}`;
  const stateRaw = state;
  const stateColored = colorState(theme, state);
  const sep = " · ";
  const contentW =
    visibleWidth(costStr) + visibleWidth(sep) + visibleWidth(turnStr) +
    visibleWidth(sep) + visibleWidth(stateRaw);
  let assembled =
    theme.bold(costStr) +
    theme.fg("dim", sep) +
    turnStr +
    theme.fg("dim", sep) +
    stateColored;
  const stateMax = inner - 2;
  if (contentW > stateMax) {
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

  // Line 4: bottom border
  const bottom = theme.fg("dim", "╰" + "─".repeat(inner) + "╯");

  return [top, line2, line3, bottom];
}

function joinBoxesRow(boxes: string[][], boxWidth: number, gap: string): string[] {
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
    // No widget needed in non-interactive mode.
    if (!ctx.hasUI) return;

    const cache = createStatusCache();

    // Register the dispatch hook that feeds incoming status envelopes into
    // the cache. Returns true to consume the envelope (stops further routing).
    (globalThis as { __pi_status_dispatch__?: (env: Envelope) => boolean }).__pi_status_dispatch__ =
      (env: Envelope) => {
        if (env.payload.kind !== "status") return false;
        cache.record(env);
        return true;
      };

    // Re-render widget whenever the cache changes.
    let cachedTui: (Component & { requestRender?: () => void }) | undefined;

    cache.subscribe(() => {
      try {
        cachedTui?.requestRender?.();
      } catch { /* best-effort */ }
    });

    ctx.ui.setWidget(
      "status-display",
      (tui) => {
        cachedTui = tui as unknown as Component & { requestRender?: () => void };
        return {
          invalidate() {},
          render(width: number): string[] {
            const entries = cache.entries();
            if (entries.length === 0) return [];

            const cols = pickCols(width, entries.length);
            const gap = "  ";
            const totalGap = gap.length * (cols - 1);
            const boxWidth = Math.max(20, Math.floor((width - totalGap) / cols));
            const theme = (ctx.ui as { theme: Theme }).theme;

            const lines: string[] = [];
            for (let i = 0; i < entries.length; i += cols) {
              const slice = entries.slice(i, i + cols);
              const boxes = slice.map((e) =>
                renderBox(theme, {
                  agentName: e.agentName,
                  modelId: e.modelId,
                  contextPct: e.contextPct,
                  costUsd: e.costUsd,
                  turnCount: e.turnCount,
                  state: e.state,
                }, boxWidth),
              );
              lines.push(...joinBoxesRow(boxes, boxWidth, gap));
            }
            return lines;
          },
        };
      },
      { placement: "aboveEditor" },
    );
  });

  // Clean up dispatch hook at session end to avoid cross-session leaks.
  pi.on("session_shutdown", async () => {
    delete (globalThis as { __pi_status_dispatch__?: unknown }).__pi_status_dispatch__;
  });
}
