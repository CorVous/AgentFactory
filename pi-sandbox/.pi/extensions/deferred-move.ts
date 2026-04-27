// Deferred-move extension. File relocations queued via the
// `deferred_move` tool are buffered in extension memory and surfaced to
// the user (via the shared deferred-confirm dialog) once the agent loop
// completes. Approved batches rename each src to its dst; rejected
// batches leave them untouched.
//
// "Verbatim" relocation: file content is bit-identical at the destination,
// only the path changes. No implicit overwrite — dst must not exist at
// queue time. To overwrite, queue a deferred_delete on the destination
// first; to change content at the new path, pair with deferred_edit (or
// deferred_write for new files). The deferred-confirm coordinator runs
// writes, edits, moves, then deletes in that order, so those compositions
// are deterministic.

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { registerDeferredHandler, type PrepareResult } from "./deferred-confirm";

type Move = { srcRel: string; srcAbs: string; dstRel: string; dstAbs: string };

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
  const moves: Move[] = [];

  pi.registerTool({
    name: "deferred_move",
    label: "Deferred Move",
    description:
      "Queue a verbatim file relocation. The file at `src` is renamed to `dst` " +
      "with bit-identical content; only the path changes. Both paths must be " +
      "relative to the sandbox root (no absolute paths, no `..`). `src` must " +
      "exist and be a regular file; `dst` must NOT already exist (no implicit " +
      "overwrite) but its parent directories are CREATED AUTOMATICALLY at apply " +
      "time — you do not need to pre-create destination directories. Use " +
      "deferred_delete on the destination first if you want to replace it. The " +
      "user approves all queued moves as part of one atomic batch — accept all " +
      "or none.",
    parameters: Type.Object({
      src: Type.String({ description: "Relative path to the existing source file." }),
      dst: Type.String({ description: "Relative path to the destination (must not already exist)." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = resolveSandboxRoot(pi, ctx.cwd);
      const vs = validatePath(params.src, root);
      if (!vs.ok) throw new Error(`deferred_move (src): ${vs.err}`);
      const vd = validatePath(params.dst, root);
      if (!vd.ok) throw new Error(`deferred_move (dst): ${vd.err}`);
      if (vs.abs === vd.abs) {
        throw new Error(`deferred_move: src and dst resolve to the same path (${params.src})`);
      }
      if (!fs.existsSync(vs.abs)) {
        throw new Error(`deferred_move: src ${params.src} does not exist`);
      }
      const stat = fs.statSync(vs.abs);
      if (!stat.isFile()) {
        throw new Error(`deferred_move: src ${params.src} is not a regular file (directories are not supported)`);
      }
      if (fs.existsSync(vd.abs)) {
        throw new Error(`deferred_move: dst ${params.dst} already exists; deferred_move does not overwrite`);
      }
      if (moves.some((m) => m.srcAbs === vs.abs)) {
        throw new Error(`deferred_move: src ${params.src} is already queued as the source of another move`);
      }
      if (moves.some((m) => m.dstAbs === vd.abs)) {
        throw new Error(`deferred_move: dst ${params.dst} is already queued as the destination of another move`);
      }

      moves.push({ srcRel: params.src, srcAbs: vs.abs, dstRel: params.dst, dstAbs: vd.abs });
      return {
        content: [
          {
            type: "text",
            text: `Queued move ${params.src} → ${params.dst} (${moves.length} pending). Will be reviewed at end of turn.`,
          },
        ],
        details: { src: params.src, dst: params.dst, queued: moves.length },
      };
    },
  });

  registerDeferredHandler({
    label: "Moves",
    extension: "deferred-move",
    priority: 25,
    async prepare(ctx): Promise<PrepareResult> {
      if (moves.length === 0) return { status: "empty" };
      const queued = moves.splice(0, moves.length);
      const root = resolveSandboxRoot(pi, ctx.cwd);

      const errors: string[] = [];
      const plans: Move[] = [];

      for (const m of queued) {
        const vs = validatePath(m.srcRel, root);
        if (!vs.ok) { errors.push(`src: ${vs.err}`); continue; }
        const vd = validatePath(m.dstRel, root);
        if (!vd.ok) { errors.push(`dst: ${vd.err}`); continue; }
        if (!fs.existsSync(vs.abs)) {
          errors.push(`${m.srcRel} → ${m.dstRel}: src no longer exists`);
          continue;
        }
        const stat = fs.statSync(vs.abs);
        if (!stat.isFile()) {
          errors.push(`${m.srcRel} → ${m.dstRel}: src is no longer a regular file`);
          continue;
        }
        if (fs.existsSync(vd.abs)) {
          errors.push(`${m.srcRel} → ${m.dstRel}: dst now exists`);
          continue;
        }
        plans.push({ srcRel: m.srcRel, srcAbs: vs.abs, dstRel: m.dstRel, dstAbs: vd.abs });
      }

      if (errors.length > 0) return { status: "error", messages: errors };
      if (plans.length === 0) return { status: "empty" };

      const preview = plans.map((p) => `${p.srcAbs} → ${p.dstAbs}`).join("\n");

      const apply = async (): Promise<{ wrote: string[]; failed: string[] }> => {
        const wrote: string[] = [];
        const failed: string[] = [];
        for (const p of plans) {
          try {
            fs.mkdirSync(path.dirname(p.dstAbs), { recursive: true });
            try {
              fs.renameSync(p.srcAbs, p.dstAbs);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "EXDEV") {
                fs.copyFileSync(p.srcAbs, p.dstAbs);
                fs.unlinkSync(p.srcAbs);
              } else {
                throw e;
              }
            }
            wrote.push(p.dstAbs);
          } catch (e) {
            failed.push(`${p.srcRel} → ${p.dstRel}: ${(e as Error).message}`);
          }
        }
        return { wrote, failed };
      };

      return {
        status: "ok",
        summary: `${plans.length} file(s)`,
        preview,
        apply,
      };
    },
  });
}
