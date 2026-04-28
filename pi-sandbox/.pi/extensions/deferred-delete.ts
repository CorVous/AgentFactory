// Deferred-delete extension. File deletions queued via the
// `deferred_delete` tool are buffered in extension memory and surfaced to
// the user (via the shared deferred-confirm dialog) once the agent loop
// completes. Approved batches unlink the listed files; rejected batches
// leave them untouched.
//
// Designed to compose with sandbox.ts: paths are validated against the
// same root (the `--sandbox-root` flag, falling back to ctx.cwd /
// process.cwd). End-of-turn approval is handled centrally by
// deferred-confirm.ts.
//
// File-only: deferred_delete refuses to remove directories and refuses to
// no-op on missing paths (the model gets an immediate error so it can
// correct the path).

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { registerDeferredHandler, type PrepareResult } from "./deferred-confirm";
import { buildDeleteArtifact } from "./_lib/submission-emit";

type Deletion = { relPath: string; absPath: string };

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

export default function (pi: ExtensionAPI) {
  const deletions: Deletion[] = [];

  pi.registerTool({
    name: "deferred_delete",
    label: "Deferred Delete",
    description:
      "Queue deletion of an existing file. The deletion is buffered in memory " +
      "and presented to the user for approval at the end of the agent loop; " +
      "nothing is removed from disk until then. `path` must be relative to the " +
      "sandbox root (no absolute paths, no `..`), must already exist, and must " +
      "be a regular file (directories are not supported). Each queued path must " +
      "be unique. The user approves all queued deletions as part of one atomic " +
      "batch — accept all or none.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to an existing file inside the sandbox root." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = resolveSandboxRoot(pi, ctx.cwd);
      const v = validatePath(params.path, root);
      if (!v.ok) throw new Error(`deferred_delete: ${v.err}`);
      if (!fs.existsSync(v.abs)) {
        throw new Error(`deferred_delete: ${params.path} does not exist`);
      }
      const stat = fs.statSync(v.abs);
      if (!stat.isFile()) {
        throw new Error(`deferred_delete: ${params.path} is not a regular file (directories are not supported)`);
      }
      if (deletions.some((d) => d.absPath === v.abs)) {
        throw new Error(`deferred_delete: ${params.path} is already queued for deletion`);
      }

      deletions.push({ relPath: params.path, absPath: v.abs });
      return {
        content: [
          {
            type: "text",
            text: `Queued deletion of ${params.path} (${deletions.length} pending). Will be reviewed at end of turn.`,
          },
        ],
        details: { path: params.path, queued: deletions.length },
      };
    },
  });

  registerDeferredHandler({
    label: "Deletes",
    extension: "deferred-delete",
    priority: 30,
    async prepare(ctx): Promise<PrepareResult> {
      if (deletions.length === 0) return { status: "empty" };
      const queued = deletions.splice(0, deletions.length);
      const root = resolveSandboxRoot(pi, ctx.cwd);

      const errors: string[] = [];
      const plans: Deletion[] = [];

      for (const d of queued) {
        const v = validatePath(d.relPath, root);
        if (!v.ok) { errors.push(v.err); continue; }
        if (!fs.existsSync(v.abs)) {
          errors.push(`${d.relPath}: file no longer exists`);
          continue;
        }
        const stat = fs.statSync(v.abs);
        if (!stat.isFile()) {
          errors.push(`${d.relPath}: no longer a regular file`);
          continue;
        }
        plans.push({ relPath: d.relPath, absPath: v.abs });
      }

      if (errors.length > 0) return { status: "error", messages: errors };
      if (plans.length === 0) return { status: "empty" };

      const preview = plans.map((p) => p.absPath).join("\n");

      const apply = async (): Promise<{ wrote: string[]; failed: string[] }> => {
        const wrote: string[] = [];
        const failed: string[] = [];
        for (const p of plans) {
          try {
            fs.unlinkSync(p.absPath);
            wrote.push(p.absPath);
          } catch (e) {
            failed.push(`${p.relPath}: ${(e as Error).message}`);
          }
        }
        return { wrote, failed };
      };

      const artifacts = plans.map((p) =>
        buildDeleteArtifact({ relPath: p.relPath, content: fs.readFileSync(p.absPath, "utf8") }),
      );

      return {
        status: "ok",
        summary: `${plans.length} file(s)`,
        preview,
        apply,
        artifacts,
      };
    },
  });
}
