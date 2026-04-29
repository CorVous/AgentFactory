// git-diff extension — runs `git diff` or `git diff --staged` in the active worktree.
//
// Targets the per-issue worktree when one is registered (after worktree_prepare),
// otherwise falls back to the kanban worktree.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execInWorktree } from "./_lib/exec-in-worktree";
import { getActiveWorktree } from "./_lib/active-worktree";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_diff",
    label: "Git Diff",
    description:
      "Show changes in the active worktree. " +
      "When `staged` is false (default), shows unstaged changes (`git diff`). " +
      "When `staged` is true, shows staged changes (`git diff --staged`). " +
      "Targets the per-issue worktree when one is registered, otherwise the kanban worktree.",
    parameters: Type.Object({
      staged: Type.Optional(
        Type.Boolean({
          description: "If true, show staged changes; if false (default), show unstaged changes.",
        }),
      ),
    }),
    async execute(_id, params) {
      const active = getActiveWorktree();
      if (!active) {
        return {
          content: [
            {
              type: "text",
              text: "git_diff: no active worktree (kanban or per-issue) — extension not initialised.",
            },
          ],
          details: { ok: false, reason: "no-worktree" },
        };
      }

      const args = params.staged ? ["diff", "--staged"] : ["diff"];
      const result = await execInWorktree("git", args, active.cwd);

      const label = params.staged ? "staged" : "unstaged";
      const body = result.exitCode !== 0
        ? `git diff failed (exit ${result.exitCode}):\n${result.stderr}`
        : result.stdout.trim() === ""
          ? `[${active.target}] No ${label} changes.`
          : result.stdout;

      return {
        content: [{ type: "text", text: body }],
        details: { ...result, cwd: active.cwd, target: active.target, staged: params.staged ?? false },
      };
    },
  });
}
