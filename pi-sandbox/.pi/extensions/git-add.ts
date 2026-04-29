// git-add extension — runs `git add <paths>` in the per-issue worktree.
//
// Each path is validated to be under the worktree root before being passed
// to git. Uses execFile argument array — no shell injection surface.
//
// Reads the worktree path from globalThis.__pi_worktree_manager__ (populated by
// worktree-manager after worktree_prepare). Fails loudly if no worktree is
// registered yet.

import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execInWorktree } from "./_lib/exec-in-worktree";

function getWorktreePath(): string | undefined {
  const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
  return g.__pi_worktree_manager__?.worktreePath;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_add",
    label: "Git Add",
    description:
      "Stage files for commit in the per-issue worktree (`git add <paths>`). " +
      "Each path must be relative to the worktree root (no absolute paths, no `..`). " +
      "Requires `worktree_prepare` to have been called first.",
    parameters: Type.Object({
      paths: Type.Array(
        Type.String({ description: "Relative path to stage, e.g. 'src/foo.ts' or '.'." }),
        { description: "List of relative paths to stage.", minItems: 1 },
      ),
    }),
    async execute(_id, params) {
      const cwd = getWorktreePath();
      if (!cwd) {
        return {
          content: [
            {
              type: "text",
              text: "git_add: no per-issue worktree registered yet — call worktree_prepare first.",
            },
          ],
          details: { ok: false, reason: "no-worktree" },
        };
      }

      // Validate that no path escapes the worktree root.
      const violations: string[] = [];
      for (const p of params.paths) {
        if (path.isAbsolute(p)) {
          violations.push(`${p}: must be a relative path`);
          continue;
        }
        const resolved = path.resolve(cwd, p);
        if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
          violations.push(`${p}: escapes worktree root`);
        }
      }
      if (violations.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `git_add: path validation failed:\n${violations.join("\n")}`,
            },
          ],
          details: { ok: false, violations },
        };
      }

      const result = await execInWorktree("git", ["add", ...params.paths], cwd);
      return {
        content: [
          {
            type: "text",
            text: result.exitCode !== 0
              ? `git add failed (exit ${result.exitCode}):\n${result.stderr}`
              : `Staged: ${params.paths.join(", ")}`,
          },
        ],
        details: { ...result, cwd, paths: params.paths },
      };
    },
  });
}
