// git-mv extension — runs `git mv <src> <dst>` in the per-issue worktree.
//
// Wraps git's atomic file rename so the move is recorded as a rename in
// history rather than as a delete+add. Both paths must be relative to the
// worktree root and must not escape it. Uses execFile argument array — no
// shell injection surface.
//
// Reads the worktree path from globalThis.__pi_worktree_manager__ (populated
// by worktree-manager after worktree_prepare). Fails loudly if no worktree
// is registered yet.

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execInWorktree } from "./_lib/exec-in-worktree";
import { getActiveWorktree } from "./_lib/active-worktree";

function validateRelativePath(p: string, cwd: string): string | null {
  if (path.isAbsolute(p)) return `${p}: must be a relative path`;
  const resolved = path.resolve(cwd, p);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    return `${p}: escapes worktree root`;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_mv",
    label: "Git Mv",
    description:
      "Rename or move a tracked file in the per-issue worktree (`git mv <src> <dst>`). " +
      "Records the operation as a rename in git history. " +
      "Both paths must be relative to the worktree root (no absolute paths, no `..`). " +
      "The destination's parent directory is auto-created. " +
      "Requires `worktree_prepare` to have been called first.",
    parameters: Type.Object({
      src: Type.String({ description: "Source path, relative to worktree root." }),
      dst: Type.String({ description: "Destination path, relative to worktree root." }),
    }),
    async execute(_id, params) {
      const active = getActiveWorktree();
      if (!active) {
        return {
          content: [
            {
              type: "text",
              text: "git_mv: no active worktree (kanban or per-issue) — extension not initialised.",
            },
          ],
          details: { ok: false, reason: "no-worktree" },
        };
      }
      const cwd = active.cwd;

      const violations: string[] = [];
      const srcViolation = validateRelativePath(params.src, cwd);
      if (srcViolation) violations.push(srcViolation);
      const dstViolation = validateRelativePath(params.dst, cwd);
      if (dstViolation) violations.push(dstViolation);
      if (violations.length > 0) {
        return {
          content: [
            { type: "text", text: `git_mv: path validation failed:\n${violations.join("\n")}` },
          ],
          details: { ok: false, violations },
        };
      }

      // git mv does not auto-create parent directories. Create the dst's
      // parent if it doesn't exist — common case is moving an issue into
      // an `issues/closed/` directory that hasn't been used yet.
      const dstParent = path.dirname(path.resolve(cwd, params.dst));
      if (!fs.existsSync(dstParent)) {
        fs.mkdirSync(dstParent, { recursive: true });
      }

      const result = await execInWorktree("git", ["mv", params.src, params.dst], cwd);
      return {
        content: [
          {
            type: "text",
            text: result.exitCode !== 0
              ? `git mv failed (exit ${result.exitCode}):\n${result.stderr}`
              : `[${active.target}] Moved: ${params.src} → ${params.dst}`,
          },
        ],
        details: { ...result, cwd, target: active.target, src: params.src, dst: params.dst },
      };
    },
  });
}
