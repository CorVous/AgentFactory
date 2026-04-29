// worktree-manager extension — per-issue git worktree lifecycle for Foremen.
//
// Reads --issue and --mesh-branch CLI flags at session_start; exposes three
// tools to the model: worktree_prepare, worktree_reintegrate, worktree_dispose.
//
// Design choice: the Foreman *model* calls these tools explicitly at the right
// points in the workflow (step 3, step 5a, step 5c). This gives the model full
// visibility into the worktree lifecycle and lets it reason about partial state.
// An alternative would be to drive the lifecycle from extension lifecycle hooks
// (session_start / session_shutdown), but that would hide the state from the
// model and complicate debugging. Since the Foreman is an LLM that needs to
// narrate its progress, explicit tool calls are the right tradeoff.
//
// References: issue #03 (happy path), ADR-0005 (Kanban/Foreman/Worker triad).

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  prepareWorktree,
  reintegrate,
  disposeWorktree,
  type ReintegrationMode,
} from "./_lib/worktree-manager";
import { registerSandboxRoot, unregisterSandboxRoot } from "./deferred/sandbox";

interface WorktreeState {
  issuePath: string;
  projectPath: string;
  meshBranch: string;
  kanbanWorktreePath: string;
  // Filled in after prepare
  worktreePath?: string;
  branchName?: string;
  mode?: ReintegrationMode;
}

// Stash on globalThis for jiti module isolation (same pattern as deferred-confirm)
function getState(): Partial<WorktreeState> {
  const g = globalThis as { __pi_worktree_manager__?: Partial<WorktreeState> };
  return (g.__pi_worktree_manager__ ??= {});
}

export default function (pi: ExtensionAPI) {
  // Register extension CLI flags so pi accepts them on the command line.
  pi.registerFlag("issue", {
    description: "Issue shorthand: <feature-slug>/<NN>-<slug> (passed by Kanban)",
    type: "string",
  });
  pi.registerFlag("mesh-branch", {
    description: "Full feature branch name, e.g. feature/<feature-slug>",
    type: "string",
  });
  pi.registerFlag("project-path", {
    description: "Absolute path to the project git repo root",
    type: "string",
  });
  pi.registerFlag("kanban-worktree", {
    description: "Absolute path to the Kanban worktree (checked out on meshBranch)",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    // Read CLI flags: --issue <feature-slug>/<NN>-<slug> and --mesh-branch <branch>
    const issueFlagRaw = pi.getFlag("issue") as string | undefined;
    const meshBranch = pi.getFlag("mesh-branch") as string | undefined;
    const projectPath = pi.getFlag("project-path") as string | undefined;
    const kanbanWorktreePath = pi.getFlag("kanban-worktree") as string | undefined;

    if (!issueFlagRaw || !meshBranch || !projectPath || !kanbanWorktreePath) {
      ctx.ui.notify(
        `worktree-manager: missing required flags. ` +
          `Needed: --issue, --mesh-branch, --project-path, --kanban-worktree. ` +
          `Got: issue=${issueFlagRaw}, meshBranch=${meshBranch}, projectPath=${projectPath}, kanbanWorktree=${kanbanWorktreePath}`,
        "warn",
      );
      return;
    }

    const state = getState();
    // --issue is passed as <feature-slug>/<NN>-<slug>; resolve against project .scratch/
    // The Kanban passes the full relative path from project root (e.g. .scratch/slug/issues/NN-slug.md)
    // OR just the basename shorthand <slug>/<NN>-<name>
    let issuePath = issueFlagRaw;
    if (!issueFlagRaw.startsWith("/") && !issueFlagRaw.includes(".scratch")) {
      // Shorthand: "<feature-slug>/<NN>-<slug>" → "<projectPath>/.scratch/<feature-slug>/issues/<NN>-<slug>.md"
      const parts = issueFlagRaw.split("/");
      if (parts.length === 2) {
        const [slug, file] = parts;
        issuePath = `${projectPath}/.scratch/${slug}/issues/${file}.md`;
      }
    } else if (!issueFlagRaw.startsWith("/")) {
      issuePath = `${projectPath}/${issueFlagRaw}`;
    }

    state.issuePath = issuePath;
    state.projectPath = projectPath;
    state.meshBranch = meshBranch;
    state.kanbanWorktreePath = kanbanWorktreePath;

    if (process.env.AGENT_DEBUG === "1") {
      ctx.ui.notify(
        `worktree-manager: issue=${issuePath} meshBranch=${meshBranch} project=${projectPath}`,
        "info",
      );
    }
  });

  pi.registerTool({
    name: "worktree_prepare",
    label: "Worktree Prepare",
    description:
      "Create the per-issue git branch and worktree for this Foreman's issue. " +
      "Branches off the mesh feature branch and returns the worktree path. " +
      "Call this at step 3 of the Foreman workflow, after claiming the issue.",
    parameters: Type.Object({
      mode: Type.Union(
        [Type.Literal("auto-merge"), Type.Literal("branch-emit")],
        {
          description:
            "Reintegration mode: 'auto-merge' for ready-for-agent (AFK), " +
            "'branch-emit' for ready-for-human (HITL, handled by #04).",
        },
      ),
    }),
    async execute(_id, params) {
      const state = getState();
      if (!state.issuePath || !state.projectPath || !state.meshBranch || !state.kanbanWorktreePath) {
        return {
          content: [
            {
              type: "text",
              text: "worktree_prepare: extension not initialised (missing CLI flags). Check --issue, --mesh-branch, --project-path, --kanban-worktree.",
            },
          ],
          details: { ok: false },
        };
      }
      try {
        const result = prepareWorktree(state.issuePath, state.projectPath, state.meshBranch, params.mode);
        state.worktreePath = result.worktreePath;
        state.branchName = result.branchName;
        state.mode = result.mode;
        // Widen the sandbox path-allowlist so the git tools can operate in
        // the per-issue worktree (which lives outside the kanban sandbox root).
        registerSandboxRoot(result.worktreePath);
        return {
          content: [
            {
              type: "text",
              text:
                `Worktree prepared.\n` +
                `  worktreePath: ${result.worktreePath}\n` +
                `  branchName:   ${result.branchName}\n` +
                `  mode:         ${result.mode}`,
            },
          ],
          details: result,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `worktree_prepare failed: ${(e as Error).message}` }],
          details: { ok: false, error: (e as Error).message },
        };
      }
    },
  });

  pi.registerTool({
    name: "worktree_reintegrate",
    label: "Worktree Reintegrate",
    description:
      "Merge the per-issue branch back into the mesh feature branch (AFK auto-merge). " +
      "Call this at step 5a of the Foreman workflow, after all tests pass and " +
      "per-issue work is committed. Returns the merge commit SHA for the closing note.",
    parameters: Type.Object({}),
    async execute() {
      const state = getState();
      if (!state.worktreePath || !state.meshBranch || !state.kanbanWorktreePath || !state.mode || !state.projectPath) {
        return {
          content: [
            {
              type: "text",
              text: "worktree_reintegrate: worktree not prepared. Call worktree_prepare first.",
            },
          ],
          details: { ok: false },
        };
      }
      try {
        const result = reintegrate(
          state.worktreePath,
          state.mode,
          state.meshBranch,
          state.kanbanWorktreePath,
        );
        const msg =
          result.mergedCommit
            ? `Merged into ${state.meshBranch}. Commit: ${result.mergedCommit}`
            : `branch-emit mode: no merge performed (HITL path, handled by #04).`;
        return {
          content: [{ type: "text", text: msg }],
          details: { ok: true, ...result },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `worktree_reintegrate failed: ${(e as Error).message}` }],
          details: { ok: false, error: (e as Error).message },
        };
      }
    },
  });

  pi.registerTool({
    name: "worktree_dispose",
    label: "Worktree Dispose",
    description:
      "Remove the per-issue worktree and delete its branch. " +
      "Call this at step 5c of the Foreman workflow, after the issue is closed " +
      "and the merge is on the mesh feature branch.",
    parameters: Type.Object({}),
    async execute() {
      const state = getState();
      if (!state.worktreePath || !state.projectPath) {
        return {
          content: [
            {
              type: "text",
              text: "worktree_dispose: worktree not prepared. Nothing to dispose.",
            },
          ],
          details: { ok: false },
        };
      }
      try {
        disposeWorktree(state.worktreePath, state.projectPath);
        const disposed = state.worktreePath;
        // Remove the per-issue worktree from the sandbox path-allowlist.
        unregisterSandboxRoot(state.worktreePath);
        state.worktreePath = undefined;
        state.branchName = undefined;
        return {
          content: [{ type: "text", text: `Worktree disposed: ${disposed}` }],
          details: { ok: true, disposed },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `worktree_dispose failed: ${(e as Error).message}` }],
          details: { ok: false, error: (e as Error).message },
        };
      }
    },
  });
}
