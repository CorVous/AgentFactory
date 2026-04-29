// git-add extension — runs `git add <paths>` in the active worktree.
//
// Each path is validated to be under the worktree root before being passed
// to git. Uses execFile argument array — no shell injection surface.
//
// Targets the per-issue worktree when one is registered (after worktree_prepare),
// otherwise falls back to the kanban worktree.

import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execInWorktree } from "./_lib/exec-in-worktree";
import { getActiveWorktree } from "./_lib/active-worktree";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_add",
    label: "Git Add",
    description:
      "Stage files for commit in the active worktree (`git add <paths>`). " +
      "Each path must be relative to the worktree root (no absolute paths, no `..`). " +
      "Targets the per-issue worktree when one is registered, otherwise the kanban worktree.",
    parameters: Type.Object({
      paths: Type.Array(
        Type.String({ description: "Relative path to stage, e.g. 'src/foo.ts' or '.'." }),
        { description: "List of relative paths to stage.", minItems: 1 },
      ),
    }),
    async execute(_id, params) {
      const active = getActiveWorktree();
      if (!active) {
        return {
          content: [
            {
              type: "text",
              text: "git_add: no active worktree (kanban or per-issue) — extension not initialised.",
            },
          ],
          details: { ok: false, reason: "no-worktree" },
        };
      }
      const cwd = active.cwd;

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
              : `[${active.target}] Staged: ${params.paths.join(", ")}`,
          },
        ],
        details: { ...result, cwd, target: active.target, paths: params.paths },
      };
    },
  });
}
