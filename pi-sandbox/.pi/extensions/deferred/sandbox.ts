// Sandbox extension — baseline rail for every agent launched via
// `npm run agent`. Disables `bash` outright and rejects any tool call
// whose `path` argument resolves outside the sandbox root.
//
// Coverage is discovered at session_start: we walk pi.getAllTools() and
// classify every tool whose schema declares `path: string` as
// path-bearing. The static fallback below is a safety net for the
// installed pi 0.70 built-ins; introspection automatically picks up
// custom tools (including deferred_write) and any future built-ins.
//
// Sandbox root is read from getHabitat().scratchRoot (materialised by
// the habitat baseline extension before this session_start runs).
// Falls back to ctx.cwd for direct `pi` invocations without the runner.
//
// Runtime root registry
// ---------------------
// Other extensions (e.g. worktree-manager) may widen the allowed path
// set by calling `registerSandboxRoot(absPath)` after `worktree_prepare`
// succeeds, and `unregisterSandboxRoot(absPath)` after `worktree_dispose`.
// The registry lives on `globalThis` to survive jiti's per-extension
// module isolation (same pattern as deferred-confirm's handler array).
//
// Footer rendering (sandbox dir, tools list, stats) lives in the
// `agent-footer` extension.

import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getHabitat } from "../_lib/habitat";

const STATIC_PATH_TOOLS = ["read", "write", "edit", "ls", "grep", "find"];

// ---------------------------------------------------------------------------
// Runtime root registry — shared via globalThis for jiti module isolation
// ---------------------------------------------------------------------------

declare global {
  var __pi_sandbox_allowed_roots__: string[] | undefined;
}

globalThis.__pi_sandbox_allowed_roots__ ??= [];

/**
 * Register an additional absolute path as a sandbox-allowed root.
 * Called by worktree-manager after worktree_prepare succeeds.
 */
export function registerSandboxRoot(absPath: string): void {
  const resolved = path.resolve(absPath);
  if (!globalThis.__pi_sandbox_allowed_roots__!.includes(resolved)) {
    globalThis.__pi_sandbox_allowed_roots__!.push(resolved);
  }
}

/**
 * Remove a previously-registered additional root.
 * Called by worktree-manager on worktree_dispose.
 */
export function unregisterSandboxRoot(absPath: string): void {
  const resolved = path.resolve(absPath);
  const arr = globalThis.__pi_sandbox_allowed_roots__!;
  const idx = arr.indexOf(resolved);
  if (idx >= 0) arr.splice(idx, 1);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function declaresPathString(parameters: unknown): boolean {
  try {
    const p = parameters as { type?: string; properties?: Record<string, { type?: string }> };
    return p?.type === "object" && p?.properties?.path?.type === "string";
  } catch {
    return false;
  }
}

/**
 * Return true if `resolved` is equal to or a child of any allowed root.
 * The primary root is always checked first; extra registered roots follow.
 */
function isUnderAllowedRoot(resolved: string, primaryRoot: string): boolean {
  const roots = [primaryRoot, ...(globalThis.__pi_sandbox_allowed_roots__ ?? [])];
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const pathTools = new Set<string>(STATIC_PATH_TOOLS);

  pi.on("session_start", async (_event, ctx) => {
    // Push the primary sandbox root so it is always in the registry.
    let primaryRoot: string;
    try {
      primaryRoot = path.resolve(getHabitat().scratchRoot);
    } catch {
      primaryRoot = path.resolve(ctx.cwd);
    }
    if (!globalThis.__pi_sandbox_allowed_roots__!.includes(primaryRoot)) {
      globalThis.__pi_sandbox_allowed_roots__!.unshift(primaryRoot);
    }

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

    let primaryRoot: string;
    try {
      primaryRoot = path.resolve(getHabitat().scratchRoot);
    } catch {
      primaryRoot = path.resolve(ctx.cwd);
    }

    const input = event.input as Record<string, unknown>;
    const raw = input.path;
    if (raw !== undefined && typeof raw !== "string") return undefined;
    const target = typeof raw === "string" && raw.length > 0 ? raw : ".";
    const resolved = path.resolve(primaryRoot, target);

    if (!isUnderAllowedRoot(resolved, primaryRoot)) {
      return {
        block: true,
        reason: `${event.toolName}: path "${target}" escapes sandbox root ${primaryRoot}`,
      };
    }
    return undefined;
  });
}
