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
import { getActiveWorktree } from "./_lib/active-worktree";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_tests",
    label: "Run Tests",
    description:
      "Run the project's test suite (`npm test`) in the active worktree. " +
      "Returns stdout, stderr, and the exit code. " +
      "Targets the per-issue worktree when one is registered, otherwise the kanban worktree. " +
      "V1 is hardcoded to Node/npm projects only. " +
      "Exit code 0 = all tests passed; non-zero = failures (check stdout/stderr).",
    parameters: Type.Object({}),
    async execute() {
      const active = getActiveWorktree();
      if (!active) {
        return {
          content: [
            {
              type: "text",
              text: "run_tests: no active worktree (kanban or per-issue) — extension not initialised.",
            },
          ],
          details: { ok: false, reason: "no-worktree" },
        };
      }

      const result = await execInWorktree("npm", ["test"], active.cwd);
      const summary = result.exitCode === 0 ? "Tests passed." : `Tests FAILED (exit ${result.exitCode}).`;
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
          },
        ],
        details: { ...result, cwd: active.cwd, target: active.target },
      };
    },
  });
}
