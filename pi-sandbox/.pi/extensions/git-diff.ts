// git-diff extension — runs `git diff` or `git diff --staged` in the per-issue worktree.
//
// Reads the worktree path from globalThis.__pi_worktree_manager__ (populated by
// worktree-manager after worktree_prepare). Fails loudly if no worktree is
// registered yet.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execInWorktree } from "./_lib/exec-in-worktree";

function getWorktreePath(): string | undefined {
  const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
  return g.__pi_worktree_manager__?.worktreePath;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_diff",
    label: "Git Diff",
    description:
      "Show changes in the per-issue worktree. " +
      "When `staged` is false (default), shows unstaged changes (`git diff`). " +
      "When `staged` is true, shows staged changes (`git diff --staged`). " +
      "Requires `worktree_prepare` to have been called first.",
    parameters: Type.Object({
      staged: Type.Optional(
        Type.Boolean({
          description: "If true, show staged changes; if false (default), show unstaged changes.",
        }),
      ),
    }),
    async execute(_id, params) {
      const cwd = getWorktreePath();
      if (!cwd) {
        return {
          content: [
            {
              type: "text",
              text: "git_diff: no per-issue worktree registered yet — call worktree_prepare first.",
            },
          ],
          details: { ok: false, reason: "no-worktree" },
        };
      }

      const args = params.staged ? ["diff", "--staged"] : ["diff"];
      const result = await execInWorktree("git", args, cwd);

      const label = params.staged ? "staged" : "unstaged";
      const body = result.exitCode !== 0
        ? `git diff failed (exit ${result.exitCode}):\n${result.stderr}`
        : result.stdout.trim() === ""
          ? `No ${label} changes.`
          : result.stdout;

      return {
        content: [{ type: "text", text: body }],
        details: { ...result, cwd, staged: params.staged ?? false },
      };
    },
  });
}
