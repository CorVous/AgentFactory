// Deferred-edit extension. Edits queued via the `deferred_edit` tool are
// buffered in extension memory and surfaced to the user (via ctx.ui.confirm)
// once the agent loop completes. Approved batches are applied atomically:
// either every queued edit lands or none does.
//
// Designed to compose with sandbox.ts: paths are validated against the same
// root (the `--sandbox-root` flag, falling back to ctx.cwd / process.cwd).
//
// Orthogonal to deferred-write: `deferred_edit` only modifies existing files;
// it never creates new ones. Recipes that want both create-on-approval and
// edit-on-approval should compose the two extensions.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const PREVIEW_LINES_PER_BLOCK = 20;

type Edit = { relPath: string; oldString: string; newString: string };

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function resolveSandboxRoot(pi: ExtensionAPI, fallback: string): string {
  const flag = pi.getFlag("sandbox-root") as string | undefined;
  return path.resolve(flag || fallback);
}

function validatePath(relPath: unknown, root: string): { ok: true; abs: string } | { ok: false; err: string } {
  if (typeof relPath !== "string" || relPath.length === 0) return { ok: false, err: "empty path" };
  if (path.isAbsolute(relPath) || relPath.split(/[/\\]/).includes("..")) {
    return { ok: false, err: `${relPath}: absolute or contains '..'` };
  }
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, err: `${relPath}: escapes sandbox` };
  }
  return { ok: true, abs };
}

function applyUnique(content: string, oldStr: string, newStr: string): { ok: true; out: string } | { ok: false; err: string } {
  if (oldStr.length === 0) return { ok: false, err: "old_string is empty" };
  const idx = content.indexOf(oldStr);
  if (idx < 0) return { ok: false, err: "old_string not found in current content" };
  if (content.indexOf(oldStr, idx + 1) >= 0) return { ok: false, err: "old_string matches multiple times; add surrounding context to make it unique" };
  return { ok: true, out: content.slice(0, idx) + newStr + content.slice(idx + oldStr.length) };
}

function clipPreview(s: string): string {
  const lines = s.split("\n");
  if (lines.length <= PREVIEW_LINES_PER_BLOCK) return s;
  return lines.slice(0, PREVIEW_LINES_PER_BLOCK).join("\n") + `\n… (+${lines.length - PREVIEW_LINES_PER_BLOCK} more lines)`;
}

export default function (pi: ExtensionAPI) {
  const edits: Edit[] = [];

  pi.registerTool({
    name: "deferred_edit",
    label: "Deferred Edit",
    description:
      "Queue an edit on an existing file. The edit is buffered in memory and " +
      "presented to the user for approval at the end of the agent loop; nothing " +
      "is written to disk until then. Use this in place of `edit`. " +
      "`path` must be relative to the sandbox root (no absolute paths, no `..`) " +
      "and must already exist. `old_string` must appear exactly once in the " +
      "file's current buffered state (after any earlier queued edits to the " +
      "same file); add surrounding context until it matches uniquely. The user " +
      "approves all queued edits as one atomic batch — accept all or none.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to an existing file inside the sandbox root." }),
      old_string: Type.String({ description: "Exact text to replace. Must match the current buffered content uniquely." }),
      new_string: Type.String({ description: "Replacement text." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = resolveSandboxRoot(pi, ctx.cwd);
      const v = validatePath(params.path, root);
      if (!v.ok) throw new Error(`deferred_edit: ${v.err}`);
      if (!fs.existsSync(v.abs)) {
        throw new Error(`deferred_edit: ${params.path} does not exist; deferred_edit only modifies existing files`);
      }

      let content = fs.readFileSync(v.abs, "utf8");
      for (const e of edits) {
        if (e.relPath !== params.path) continue;
        const r = applyUnique(content, e.oldString, e.newString);
        if (!r.ok) {
          throw new Error(`deferred_edit: replaying earlier queued edits on ${params.path} failed: ${r.err}`);
        }
        content = r.out;
      }
      const r = applyUnique(content, params.old_string, params.new_string);
      if (!r.ok) {
        throw new Error(`deferred_edit on ${params.path}: ${r.err}`);
      }

      edits.push({ relPath: params.path, oldString: params.old_string, newString: params.new_string });
      const newBytes = Buffer.byteLength(params.new_string, "utf8");
      const oldBytes = Buffer.byteLength(params.old_string, "utf8");
      return {
        content: [
          {
            type: "text",
            text: `Queued edit on ${params.path} (-${oldBytes}+${newBytes} bytes; ${edits.length} pending). Will be reviewed at end of turn.`,
          },
        ],
        details: { path: params.path, queued: edits.length, oldBytes, newBytes },
      };
    },
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (edits.length === 0) return;
    const queued = edits.splice(0, edits.length);
    const root = resolveSandboxRoot(pi, ctx.cwd);

    type FilePlan = { relPath: string; destAbs: string; original: string; final: string; edits: Edit[] };
    const fileMap = new Map<string, FilePlan>();
    const errors: string[] = [];

    for (const e of queued) {
      const v = validatePath(e.relPath, root);
      if (!v.ok) { errors.push(v.err); continue; }
      let plan = fileMap.get(v.abs);
      if (!plan) {
        if (!fs.existsSync(v.abs)) {
          errors.push(`${e.relPath}: file no longer exists`);
          continue;
        }
        const original = fs.readFileSync(v.abs, "utf8");
        plan = { relPath: e.relPath, destAbs: v.abs, original, final: original, edits: [] };
        fileMap.set(v.abs, plan);
      }
      const r = applyUnique(plan.final, e.oldString, e.newString);
      if (!r.ok) { errors.push(`${e.relPath}: ${r.err}`); continue; }
      plan.final = r.out;
      plan.edits.push(e);
    }

    if (errors.length > 0) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `deferred_edit aborted (re-validation failed for ${errors.length} edit(s)):\n${errors.join("\n")}`,
          "error",
        );
      }
      return;
    }

    const plans = [...fileMap.values()].filter((p) => p.final !== p.original);
    if (plans.length === 0) {
      if (ctx.hasUI) ctx.ui.notify("deferred_edit: no net changes to apply", "warning");
      return;
    }

    if (!ctx.hasUI) {
      // Non-interactive: refuse to write without confirmation.
      return;
    }

    const totalEdits = plans.reduce((n, p) => n + p.edits.length, 0);
    const preview = plans
      .map((p) => {
        const header = `${p.destAbs} (${p.edits.length} edit${p.edits.length === 1 ? "" : "s"})`;
        const blocks = p.edits.map((e, i) => {
          return `Edit ${i + 1}:\n--- old\n${clipPreview(e.oldString)}\n+++ new\n${clipPreview(e.newString)}`;
        });
        return [header, ...blocks].join("\n\n");
      })
      .join("\n\n---\n\n");

    const ok = await ctx.ui.confirm(`Apply ${totalEdits} edit(s) across ${plans.length} file(s)?`, preview);
    if (!ok) {
      ctx.ui.notify("deferred_edit: cancelled, nothing written", "info");
      return;
    }

    const wrote: string[] = [];
    const failed: string[] = [];
    for (const p of plans) {
      try {
        const expected = sha256(p.final);
        fs.writeFileSync(p.destAbs, p.final, "utf8");
        const back = sha256(fs.readFileSync(p.destAbs, "utf8"));
        if (back !== expected) {
          failed.push(`${p.relPath}: sha mismatch after write`);
          continue;
        }
        wrote.push(p.destAbs);
      } catch (e) {
        failed.push(`${p.relPath}: ${(e as Error).message}`);
      }
    }
    if (failed.length > 0) ctx.ui.notify(`deferred_edit failures:\n${failed.join("\n")}`, "error");
    if (wrote.length > 0) ctx.ui.notify(`deferred_edit wrote:\n${wrote.join("\n")}`, "info");
  });
}
