// hide-extensions-list — baseline rail that strips pi's `[Extensions]`
// section from the chat history at startup. The agent-footer already
// shows the active tools, and the path listing pi appends is noise.
//
// Pi calls `showLoadedResources` immediately after extension
// session_start handlers finish, with no per-section suppression in
// the public extension API. So we use `setWidget` as a side-channel
// to capture the TUI instance, schedule a setTimeout(0) callback that
// runs after `showLoadedResources` has appended the section, and
// splice the matching subtree (plus its trailing Spacer) out of the
// chat container.
//
// This reaches into private TUI state shape and is fragile if pi's
// internal layout changes. If a future pi exposes a quietStartup
// setter via the extension API, prefer that and delete this rail.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";

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
    // Otherwise an ancestor (e.g. pi's chatContainer when [Extensions] is its
    // first child) matches at the wrong level and we splice the whole
    // ancestor out, taking all chat history with it.
    if (findAndRemove(arr[i]!, label)) return true;
    if (firstStrippedLine(arr[i]!) === label) {
      // Drop the matched section and the trailing Spacer pi adds after it.
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
        // ctx may be stale if pi replaced its session (e.g. non-PTY subprocess);
        // widget cleanup is best-effort — nothing to do if the session is gone.
      }
    }, 0);
  });
}
