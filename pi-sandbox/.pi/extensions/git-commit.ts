// git-commit extension — runs `git commit -m <message>` in the active worktree.
//
// The message is passed as a separate argument in the execFile args array so
// no shell escaping is needed and shell injection is impossible.
//
// Targets the per-issue worktree when one is registered (after worktree_prepare),
// otherwise falls back to the kanban worktree.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execInWorktree } from "./_lib/exec-in-worktree";
import { getActiveWorktree } from "./_lib/active-worktree";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_commit",
    label: "Git Commit",
    description:
      "Record staged changes as a commit in the active worktree (`git commit -m <message>`). " +
      "The message is passed as a separate argument — no shell escaping needed. " +
      "Requires staged changes (call `git_add` first). " +
      "Targets the per-issue worktree when one is registered, otherwise the kanban worktree.",
    parameters: Type.Object({
      message: Type.String({
        description: "Commit message. Keep it concise and descriptive.",
        minLength: 1,
      }),
    }),
    async execute(_id, params) {
      const active = getActiveWorktree();
      if (!active) {
        return {
          content: [
            {
              type: "text",
              text: "git_commit: no active worktree (kanban or per-issue) — extension not initialised.",
            },
          ],
          details: { ok: false, reason: "no-worktree" },
        };
      }

      // Pass message as a separate argv element — no shell escaping needed.
      const result = await execInWorktree("git", ["commit", "-m", params.message], active.cwd);
      return {
        content: [
          {
            type: "text",
            text: result.exitCode !== 0
              ? `git commit failed (exit ${result.exitCode}):\n${result.stderr}`
              : `[${active.target}] ${result.stdout.trim() || "Commit created."}`,
          },
        ],
        details: { ...result, cwd: active.cwd, target: active.target, message: params.message },
      };
    },
  });
}
