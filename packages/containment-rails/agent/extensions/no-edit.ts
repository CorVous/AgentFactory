// no-edit extension — composes with deferred-write (or plain write) to
// enforce that the agent only creates new files, never modifies existing
// ones. Drop this extension from a recipe to allow overwrite/edit.
//
// NOTE: This file is COPIED from pi-sandbox/.pi/extensions/no-edit.ts.
// The pi-sandbox copy remains for run-agent.mjs compatibility until Slice 7.

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHabitat } from "@agentfactory/pi-engine/lib/habitat-glue.js";

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

    try {
      if (getHabitat().debug === true) {
        const dump = `no-edit createOnlyTools = [${[...createOnlyTools].sort().join(", ")}]`;
        ctx.ui.notify(dump, "info");
        process.stderr.write(`[no-edit] ${dump}\n`);
      }
    } catch { /* Habitat not available */ }
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
