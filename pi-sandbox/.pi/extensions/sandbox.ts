// Sandbox extension — baseline rail for every agent launched via
// `npm run agent`. Disables `bash` outright and rejects any built-in
// fs tool call whose `path` argument resolves outside the sandbox root.
//
// Sandbox root is read from AGENT_SANDBOX_ROOT (set by scripts/run-agent.mjs)
// and falls back to ctx.cwd. The runner spawns pi with cwd = sandbox root,
// so a missing/empty `path` (which the built-in tools resolve to ".") is
// always inside the root.

import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      return { block: true, reason: "bash is disabled in this sandbox" };
    }

    if (!PATH_TOOLS.has(event.toolName)) return undefined;

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

  pi.on("session_start", async (_event, ctx) => {
    const root = process.env.AGENT_SANDBOX_ROOT || ctx.cwd;
    ctx.ui.notify(`sandbox active: fs limited to ${root}, bash disabled`, "info");
  });
}
