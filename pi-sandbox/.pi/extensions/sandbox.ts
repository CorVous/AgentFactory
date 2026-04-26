// Sandbox extension — baseline rail for every agent launched via
// `npm run agent`. Disables `bash` outright and rejects any tool call
// whose `path` argument resolves outside the sandbox root.
//
// Coverage is discovered at session_start: we walk pi.getAllTools() and
// classify every tool whose schema declares `path: string` as
// path-bearing. The static fallback below is a safety net for the
// installed pi 0.69 built-ins; introspection automatically picks up
// custom tools (including deferred_write) and any future built-ins.
//
// Sandbox root is read from the `--sandbox-root` flag (set by
// scripts/run-agent.mjs) and falls back to ctx.cwd. The runner spawns pi
// with cwd = sandbox root, so a missing/empty `path` (which the built-in
// tools resolve to ".") is always inside the root. This extension owns
// the `--sandbox-root` flag; the agent-footer, deferred-write, and
// no-edit extensions read it via pi.getFlag.
//
// Footer rendering (sandbox dir, tools list, stats) lives in the
// `agent-footer` extension.

import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STATIC_PATH_TOOLS = ["read", "write", "edit", "ls", "grep", "find"];

function declaresPathString(parameters: unknown): boolean {
  try {
    const p = parameters as { type?: string; properties?: Record<string, { type?: string }> };
    return p?.type === "object" && p?.properties?.path?.type === "string";
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("sandbox-root", {
    description: "Root directory for the sandbox; tool calls outside it are blocked",
    type: "string",
  });

  const pathTools = new Set<string>(STATIC_PATH_TOOLS);

  pi.on("session_start", async (_event, ctx) => {
    try {
      for (const tool of pi.getAllTools()) {
        if (declaresPathString(tool.parameters)) pathTools.add(tool.name);
      }
    } catch (e) {
      ctx.ui.notify(
        `sandbox: tool introspection failed (${(e as Error).message}); using static fallback`,
        "warning",
      );
    }

    if (process.env.AGENT_DEBUG === "1") {
      const dump = `sandbox pathTools = [${[...pathTools].sort().join(", ")}]`;
      ctx.ui.notify(dump, "info");
      process.stderr.write(`[AGENT_DEBUG] ${dump}\n`);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      return { block: true, reason: "bash is disabled in this sandbox" };
    }

    if (!pathTools.has(event.toolName)) return undefined;

    const root = path.resolve((pi.getFlag("sandbox-root") as string | undefined) || ctx.cwd);
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
}
