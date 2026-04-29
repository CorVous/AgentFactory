// run-tests extension — runs `npm test` in the per-issue worktree.
//
// V1 hardcoded to Node/npm projects only (runs `npm test`). The worktree
// path is read from the shared globalThis.__pi_worktree_manager__ state,
// populated by the worktree-manager extension after worktree_prepare
// succeeds. If the worktree is not yet prepared, the tool fails loudly so
// the model knows it must call worktree_prepare first.
//
// Uses execInWorktree (execFile argument array) — no shell injection surface.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execInWorktree } from "./_lib/exec-in-worktree";

function getWorktreePath(): string | undefined {
  const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
  return g.__pi_worktree_manager__?.worktreePath;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_tests",
    label: "Run Tests",
    description:
      "Run the project's test suite (`npm test`) in the per-issue worktree. " +
      "Returns stdout, stderr, and the exit code. " +
      "V1 is hardcoded to Node/npm projects only. " +
      "Requires `worktree_prepare` to have been called first. " +
      "Exit code 0 = all tests passed; non-zero = failures (check stdout/stderr).",
    parameters: Type.Object({}),
    async execute() {
      const cwd = getWorktreePath();
      if (!cwd) {
        return {
          content: [
            {
              type: "text",
              text: "run_tests: no per-issue worktree registered yet — call worktree_prepare first.",
            },
          ],
          details: { ok: false, reason: "no-worktree" },
        };
      }

      const result = await execInWorktree("npm", ["test"], cwd);
      const summary = result.exitCode === 0 ? "Tests passed." : `Tests FAILED (exit ${result.exitCode}).`;
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
          },
        ],
        details: { ...result, cwd },
      };
    },
  });
}
