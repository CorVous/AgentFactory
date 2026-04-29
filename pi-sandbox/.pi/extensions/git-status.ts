// git-status extension — runs `git status --porcelain` in the active worktree.
//
// Targets the per-issue worktree when one is registered (after worktree_prepare),
// otherwise falls back to the kanban worktree. Both paths come from the shared
// globalThis.__pi_worktree_manager__ stash.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execInWorktree } from "./_lib/exec-in-worktree";
import { getActiveWorktree } from "./_lib/active-worktree";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_status",
    label: "Git Status",
    description:
      "Show the working tree status of the active worktree (`git status --porcelain`). " +
      "Returns the porcelain output (empty string means clean). " +
      "Targets the per-issue worktree when one is registered, otherwise the kanban worktree.",
    parameters: Type.Object({}),
    async execute() {
      const active = getActiveWorktree();
      if (!active) {
        return {
          content: [
            {
              type: "text",
              text: "git_status: no active worktree (kanban or per-issue) — extension not initialised.",
            },
          ],
          details: { ok: false, reason: "no-worktree" },
        };
      }

      const result = await execInWorktree("git", ["status", "--porcelain"], active.cwd);
      const clean = result.exitCode === 0 && result.stdout.trim() === "";
      const summary = clean ? "Working tree clean." : `Untracked/modified files:\n${result.stdout}`;
      return {
        content: [
          {
            type: "text",
            text: result.exitCode !== 0
              ? `git status failed (exit ${result.exitCode}):\n${result.stderr}`
              : `[${active.target}] ${summary}`,
          },
        ],
        details: { ...result, cwd: active.cwd, target: active.target, clean },
      };
    },
  });
}
