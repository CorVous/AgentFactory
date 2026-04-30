// Deferred-write extension. Drafts written via the `deferred_write` tool
// are buffered in extension memory and surfaced to the user (via the
// shared deferred-confirm dialog) once the agent loop completes. Approved
// drafts are written to disk under the sandbox root; rejected drafts are
// discarded.
//
// This extension does not enforce no-overwrite. If a recipe wants to
// forbid modifying existing files, pair it with the `no-edit` extension,
// which blocks `edit` outright and rejects `write`/`deferred_write`
// targeting paths that already exist.
//
// End-of-turn approval is handled centrally by deferred-confirm.ts; this
// extension registers a handler with the shared bus rather than driving
// its own ctx.ui.confirm dialog.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { registerDeferredHandler, type PrepareResult } from "./deferred-confirm";
import { buildWriteArtifact } from "../_lib/submission-emit";

const MAX_FILES_PER_TURN = 50;
const MAX_BYTES_PER_FILE = 2_000_000;
const PREVIEW_LINES_PER_FILE = 20;

type Draft = { relPath: string; content: string };

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export default function (pi: ExtensionAPI) {
  const drafts: Draft[] = [];

  pi.registerTool({
    name: "deferred_write",
    label: "Deferred Write",
    description:
      "Draft a file. Content is buffered in memory and presented to the user " +
      "for approval at the end of the agent loop; nothing hits disk until then. " +
      "Use this in place of `write`. `path` must be relative to the sandbox root " +
      "(no absolute paths, no `..`). `content` MUST be the complete, final file " +
      "contents — every line you want on disk, verbatim. Do not abbreviate or " +
      "use placeholders like `...`, `// rest unchanged`, or `TODO: fill in`. " +
      "Approved drafts are written; rejected drafts are discarded.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative destination path inside the sandbox root." }),
      content: Type.String({
        description:
          "Complete final text of the file. Every line you want on disk, " +
          "verbatim — no placeholders, no abbreviations, no `...`.",
      }),
    }),
    async execute(_id, params) {
      const bytes = Buffer.byteLength(params.content, "utf8");
      drafts.push({ relPath: params.path, content: params.content });
      return {
        content: [
          {
            type: "text",
            text: `Drafted ${params.path} (${bytes} bytes). Buffered in memory; will be reviewed at end of turn.`,
          },
        ],
        details: { path: params.path, bytes, queued: drafts.length },
      };
    },
  });

  registerDeferredHandler({
    label: "Writes",
    extension: "deferred-write",
    priority: 10,
    async prepare(ctx): Promise<PrepareResult> {
      if (drafts.length === 0) return { status: "empty" };
      const queued = drafts.splice(0, drafts.length);
      const root = path.resolve((pi.getFlag("sandbox-root") as string | undefined) || ctx.cwd);

      type Plan = { relPath: string; destAbs: string; content: string; sha: string; bytes: number };
      const plans: Plan[] = [];
      const errors: string[] = [];

      for (const d of queued) {
        if (typeof d.relPath !== "string" || d.relPath.length === 0) {
          errors.push("<empty path>");
          continue;
        }
        if (path.isAbsolute(d.relPath) || d.relPath.split(/[/\\]/).includes("..")) {
          errors.push(`${d.relPath}: absolute or contains '..'`);
          continue;
        }
        const destAbs = path.resolve(root, d.relPath);
        if (destAbs !== root && !destAbs.startsWith(root + path.sep)) {
          errors.push(`${d.relPath}: escapes sandbox`);
          continue;
        }
        const bytes = Buffer.byteLength(d.content, "utf8");
        if (bytes > MAX_BYTES_PER_FILE) {
          errors.push(`${d.relPath}: ${bytes} bytes > ${MAX_BYTES_PER_FILE}`);
          continue;
        }
        plans.push({ relPath: d.relPath, destAbs, content: d.content, sha: sha256(d.content), bytes });
      }

      if (plans.length > MAX_FILES_PER_TURN) {
        errors.push(`${plans.length} drafts exceeds limit of ${MAX_FILES_PER_TURN}`);
      }
      if (errors.length > 0) return { status: "error", messages: errors };
      if (plans.length === 0) return { status: "empty" };

      const preview = plans
        .map((p) => {
          const overwrite = fs.existsSync(p.destAbs) ? " [OVERWRITE]" : "";
          const header = `${p.destAbs} (${p.bytes} bytes, sha ${p.sha.slice(0, 10)}…)${overwrite}`;
          const lines = p.content.split("\n");
          const shown = lines.slice(0, PREVIEW_LINES_PER_FILE).join("\n");
          const tail =
            lines.length > PREVIEW_LINES_PER_FILE
              ? `\n… (+${lines.length - PREVIEW_LINES_PER_FILE} more lines)`
              : "";
          return `${header}\n\n${shown}${tail}`;
        })
        .join("\n\n---\n\n");

      const apply = async (): Promise<{ wrote: string[]; failed: string[] }> => {
        const wrote: string[] = [];
        const failed: string[] = [];
        for (const p of plans) {
          try {
            fs.mkdirSync(path.dirname(p.destAbs), { recursive: true });
            fs.writeFileSync(p.destAbs, p.content, "utf8");
            const back = sha256(fs.readFileSync(p.destAbs, "utf8"));
            if (back !== p.sha) {
              failed.push(`${p.relPath}: sha mismatch after write`);
              continue;
            }
            wrote.push(p.destAbs);
          } catch (e) {
            failed.push(`${p.relPath}: ${(e as Error).message}`);
          }
        }
        return { wrote, failed };
      };

      const artifacts = plans.map((p) => buildWriteArtifact({ relPath: p.relPath, content: p.content }));

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
