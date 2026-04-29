// git-commit extension — runs `git commit -m <message>` in the per-issue worktree.
//
// The message is passed as a separate argument in the execFile args array so
// no shell escaping is needed and shell injection is impossible.
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
    name: "git_commit",
    label: "Git Commit",
    description:
      "Record staged changes as a commit in the per-issue worktree (`git commit -m <message>`). " +
      "The message is passed as a separate argument — no shell escaping needed. " +
      "Requires staged changes (call `git_add` first). " +
      "Requires `worktree_prepare` to have been called first.",
    parameters: Type.Object({
      message: Type.String({
        description: "Commit message. Keep it concise and descriptive.",
        minLength: 1,
      }),
    }),
    async execute(_id, params) {
      const cwd = getWorktreePath();
      if (!cwd) {
        return {
          content: [
            {
              type: "text",
              text: "git_commit: no per-issue worktree registered yet — call worktree_prepare first.",
            },
          ],
          details: { ok: false, reason: "no-worktree" },
        };
      }

      // Pass message as a separate argv element — no shell escaping needed.
      const result = await execInWorktree("git", ["commit", "-m", params.message], cwd);
      return {
        content: [
          {
            type: "text",
            text: result.exitCode !== 0
              ? `git commit failed (exit ${result.exitCode}):\n${result.stderr}`
              : result.stdout.trim() || "Commit created.",
          },
        ],
        details: { ...result, cwd, message: params.message },
      };
    },
  });
}
