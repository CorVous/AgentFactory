// no-edit extension — composes with deferred-write (or plain write) to
// enforce that the agent only creates new files, never modifies existing
// ones. Drop this extension from a recipe to allow overwrite/edit.
//
// Behavior:
// - `edit` is blocked unconditionally (it always targets an existing file).
// - `write` and `deferred_write` are blocked when the resolved target
//   already exists. Paths resolve against AGENT_SANDBOX_ROOT (set by
//   scripts/run-agent.mjs) or process.cwd() as a fallback.

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CREATE_ONLY_TOOLS = new Set(["write", "deferred_write"]);

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "edit") {
      return { block: true, reason: "no-edit: editing existing files is disabled" };
    }

    if (!CREATE_ONLY_TOOLS.has(event.toolName)) return undefined;

    const raw = (event.input as Record<string, unknown>).path;
    if (typeof raw !== "string" || raw.length === 0) return undefined;

    const root = path.resolve(process.env.AGENT_SANDBOX_ROOT || process.cwd());
    const abs = path.isAbsolute(raw) ? raw : path.resolve(root, raw);

    if (fs.existsSync(abs)) {
      return {
        block: true,
        reason: `no-edit: ${event.toolName} target "${raw}" already exists; only new files are allowed`,
      };
    }
    return undefined;
  });
}
