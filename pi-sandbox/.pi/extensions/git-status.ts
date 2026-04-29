// git-status extension — runs `git status --porcelain` in the per-issue worktree.
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
    name: "git_status",
    label: "Git Status",
    description:
      "Show the working tree status of the per-issue worktree (`git status --porcelain`). " +
      "Returns the porcelain output (empty string means clean). " +
      "Requires `worktree_prepare` to have been called first.",
    parameters: Type.Object({}),
    async execute() {
      const cwd = getWorktreePath();
      if (!cwd) {
        return {
          content: [
            {
              type: "text",
              text: "git_status: no per-issue worktree registered yet — call worktree_prepare first.",
            },
          ],
          details: { ok: false, reason: "no-worktree" },
        };
      }

      const result = await execInWorktree("git", ["status", "--porcelain"], cwd);
      const clean = result.exitCode === 0 && result.stdout.trim() === "";
      const summary = clean ? "Working tree clean." : `Untracked/modified files:\n${result.stdout}`;
      return {
        content: [
          {
            type: "text",
            text: result.exitCode !== 0
              ? `git status failed (exit ${result.exitCode}):\n${result.stderr}`
              : summary,
          },
        ],
        details: { ...result, cwd, clean },
      };
    },
  });
}
