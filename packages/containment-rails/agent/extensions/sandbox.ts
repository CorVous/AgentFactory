// Sandbox extension — baseline rail for every agent launched via
// `npm run agent`. Disables `bash` outright and rejects any tool call
// whose `path` argument resolves outside the sandbox root.
//
// NOTE: This file is COPIED from pi-sandbox/.pi/extensions/sandbox.ts.
// The pi-sandbox copy is the legacy extension path; the canonical copy is this package.

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHabitat } from "@agentfactory/pi-engine/lib/habitat-glue.js";

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

    try {
      if (getHabitat().debug === true) {
        const dump = `sandbox pathTools = [${[...pathTools].sort().join(", ")}]`;
        ctx.ui.notify(dump, "info");
        process.stderr.write(`[sandbox] ${dump}\n`);
      }
    } catch { /* Habitat not available */ }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      return { block: true, reason: "bash is disabled in this sandbox" };
    }

    if (!pathTools.has(event.toolName)) return undefined;

    let root: string;
    try {
      root = path.resolve(getHabitat().scratchRoot);
    } catch {
      root = path.resolve(ctx.cwd);
    }

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
