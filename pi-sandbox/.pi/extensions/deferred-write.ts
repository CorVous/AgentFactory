// Deferred-write extension. Drafts written via the `deferred_write` tool
// are buffered in extension memory and surfaced to the user (via
// ctx.ui.confirm) once the agent loop completes. Approved drafts are
// written to disk under the sandbox root; rejected drafts are discarded.
//
// This extension does not enforce no-overwrite. If a recipe wants to
// forbid modifying existing files, pair it with the `no-edit` extension,
// which blocks `edit` outright and rejects `write`/`deferred_write`
// targeting paths that already exist.
//
// Designed to compose with sandbox.ts: paths are validated against the
// same root (the `--sandbox-root` flag, falling back to ctx.cwd).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

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

  pi.on("agent_end", async (_event, ctx) => {
    if (drafts.length === 0) return;
    const queued = drafts.splice(0, drafts.length);
    const root = path.resolve((pi.getFlag("sandbox-root") as string | undefined) || ctx.cwd);

    type Plan = { relPath: string; destAbs: string; content: string; sha: string; bytes: number };
    const plans: Plan[] = [];
    const skips: string[] = [];

    for (const d of queued) {
      if (typeof d.relPath !== "string" || d.relPath.length === 0) {
        skips.push(`<empty path>`);
        continue;
      }
      if (path.isAbsolute(d.relPath) || d.relPath.split(/[/\\]/).includes("..")) {
        skips.push(`${d.relPath}: absolute or contains '..'`);
        continue;
      }
      const destAbs = path.resolve(root, d.relPath);
      if (destAbs !== root && !destAbs.startsWith(root + path.sep)) {
        skips.push(`${d.relPath}: escapes sandbox`);
        continue;
      }
      const bytes = Buffer.byteLength(d.content, "utf8");
      if (bytes > MAX_BYTES_PER_FILE) {
        skips.push(`${d.relPath}: ${bytes} bytes > ${MAX_BYTES_PER_FILE}`);
        continue;
      }
      plans.push({ relPath: d.relPath, destAbs, content: d.content, sha: sha256(d.content), bytes });
    }

    for (const s of skips) {
      if (ctx.hasUI) ctx.ui.notify(`deferred_write skip: ${s}`, "warning");
    }
    if (plans.length === 0) {
      if (ctx.hasUI) ctx.ui.notify("deferred_write: no promotable drafts", "warning");
      return;
    }
    if (plans.length > MAX_FILES_PER_TURN) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `deferred_write: ${plans.length} drafts exceeds limit of ${MAX_FILES_PER_TURN}; aborting`,
          "error",
        );
      }
      return;
    }

    if (!ctx.hasUI) {
      // Non-interactive: refuse to write without confirmation.
      return;
    }

    const preview = plans
      .map((p) => {
        const overwrite = fs.existsSync(p.destAbs) ? " [OVERWRITE]" : "";
        const header = `${p.destAbs} (${p.bytes} bytes, sha ${p.sha.slice(0, 10)}…)${overwrite}`;
        const lines = p.content.split("\n");
        const shown = lines.slice(0, PREVIEW_LINES_PER_FILE).join("\n\n");
        const tail =
          lines.length > PREVIEW_LINES_PER_FILE
            ? `\n\n… (+${lines.length - PREVIEW_LINES_PER_FILE} more lines)`
            : "";
        return `${header}\n\n${shown}${tail}`;
      })
      .join("\n\n---\n\n");

    const ok = await ctx.ui.confirm(`Promote ${plans.length} file(s)?`, preview);
    if (!ok) {
      ctx.ui.notify("deferred_write: cancelled, nothing written", "info");
      return;
    }

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
    if (failed.length > 0) ctx.ui.notify(`deferred_write failures:\n${failed.join("\n")}`, "error");
    if (wrote.length > 0) ctx.ui.notify(`deferred_write wrote:\n${wrote.join("\n")}`, "info");
  });
}
