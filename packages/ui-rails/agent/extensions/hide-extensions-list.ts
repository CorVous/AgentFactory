// hide-extensions-list — baseline rail that strips pi's `[Extensions]`
// section from the chat history at startup.
//
// Canonical source: this package (pi-sandbox/.pi/extensions/ copy removed in Slice 9).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SECTION_LABEL = "[Extensions]";
const PROBE_WIDTH = 80;

function isContainer(node: unknown): node is { children: Component[] } {
  return (
    node !== null &&
    typeof node === "object" &&
    "children" in (node as object) &&
    Array.isArray((node as { children: unknown }).children)
  );
}

function firstStrippedLine(node: Component): string {
  try {
    const lines = node.render(PROBE_WIDTH);
    if (!lines || lines.length === 0) return "";
    return (lines[0] ?? "").replace(ANSI_RE, "").trim();
  } catch {
    return "";
  }
}

function findAndRemove(node: Component, label: string): boolean {
  if (!isContainer(node)) return false;
  const arr = node.children;
  for (let i = 0; i < arr.length; i++) {
    // Recurse first so deeper matches splice from the closest container.
    if (findAndRemove(arr[i]!, label)) return true;
    if (firstStrippedLine(arr[i]!) === label) {
      arr.splice(i, i + 1 < arr.length ? 2 : 1);
      return true;
    }
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const captureKey = "hide-extensions-list:capture";
    let tui: Component | undefined;

    ctx.ui.setWidget(
      captureKey,
      (t) => {
        tui = t as unknown as Component;
        return {
          render: () => [],
          invalidate: () => {},
        };
      },
      { placement: "belowEditor" },
    );

    setTimeout(() => {
      try {
        if (tui && findAndRemove(tui, SECTION_LABEL)) {
          (tui as { requestRender?: () => void }).requestRender?.();
        }
        ctx.ui.setWidget(captureKey, undefined);
      } catch {
        // ctx may be stale; widget cleanup is best-effort.
      }
    }, 0);
  });
}
