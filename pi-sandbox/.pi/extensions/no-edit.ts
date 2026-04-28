// no-edit extension — composes with deferred-write (or plain write) to
// enforce that the agent only creates new files, never modifies existing
// ones. Drop this extension from a recipe to allow overwrite/edit.
//
// Behavior:
// - `edit` is blocked unconditionally (it always targets an existing
//   file). If pi gains another edit-shaped built-in, hardcode it next
//   to "edit" below — there's no recipe override for that today.
// - `write`, `deferred_write`, and any tool whose schema declares
//   `path: string` plus a content-shaped string field
//   (`content` | `text` | `body`) are blocked when the resolved target
//   already exists. Coverage is discovered at session_start via
//   pi.getAllTools(); the static fallback covers pi 0.70's built-in
//   `write` plus our `deferred_write`.
//
// Recipe overrides via Habitat (getHabitat().noEditAdd / noEditSkip),
// forwarded by scripts/run-agent.mjs from the recipe's noEditAdd /
// noEditSkip fields.

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getHabitat } from "./_lib/habitat";

const STATIC_CREATE_ONLY_TOOLS = ["write", "deferred_write"];
const CONTENT_KEYS = ["content", "text", "body"];

function declaresWriteShape(parameters: unknown): boolean {
  try {
    const p = parameters as { type?: string; properties?: Record<string, { type?: string }> };
    if (p?.type !== "object" || p?.properties?.path?.type !== "string") return false;
    return CONTENT_KEYS.some((k) => p.properties?.[k]?.type === "string");
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  const createOnlyTools = new Set<string>(STATIC_CREATE_ONLY_TOOLS);

  pi.on("session_start", async (_event, ctx) => {
    try {
      for (const tool of pi.getAllTools()) {
        if (declaresWriteShape(tool.parameters)) createOnlyTools.add(tool.name);
      }
    } catch (e) {
      ctx.ui.notify(
        `no-edit: tool introspection failed (${(e as Error).message}); using static fallback`,
        "warning",
      );
    }

    let noEditAdd: string[] = [];
    let noEditSkip: string[] = [];
    try {
      const h = getHabitat();
      noEditAdd = h.noEditAdd;
      noEditSkip = h.noEditSkip;
    } catch {
      // Habitat not yet set; use empty lists (no recipe overrides).
    }
    for (const t of noEditAdd) createOnlyTools.add(t);
    for (const t of noEditSkip) createOnlyTools.delete(t);

    if (process.env.AGENT_DEBUG === "1") {
      const dump = `no-edit createOnlyTools = [${[...createOnlyTools].sort().join(", ")}]`;
      ctx.ui.notify(dump, "info");
      process.stderr.write(`[AGENT_DEBUG] ${dump}\n`);
    }
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "edit") {
      return { block: true, reason: "no-edit: editing existing files is disabled" };
    }

    if (!createOnlyTools.has(event.toolName)) return undefined;

    const raw = (event.input as Record<string, unknown>).path;
    if (typeof raw !== "string" || raw.length === 0) return undefined;

    let root: string;
    try {
      root = path.resolve(getHabitat().scratchRoot);
    } catch {
      root = path.resolve(process.cwd());
    }
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
