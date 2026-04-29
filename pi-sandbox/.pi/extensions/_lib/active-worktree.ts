/**
 * Resolve the "active" worktree path for a Foreman tool call.
 *
 * Foremen flow through two distinct worktrees:
 *   1. **Kanban worktree** — where the Foreman is spawned (cwd at session
 *      start). The issue file lives here at `.scratch/<slug>/issues/<NN>.md`.
 *   2. **Per-issue worktree** — created by `worktree_prepare` for the TDD
 *      loop. Lives at `.mesh-features/<slug>/foreman-<NN>-<slug>/`.
 *
 * The git-* and run_tests tools resolve their target as follows:
 *   - If `worktree_prepare` has been called and `worktree_dispose` has NOT,
 *     they target the per-issue worktree.
 *   - Otherwise (before prepare or after dispose), they target the kanban
 *     worktree. This lets the close-issue step at Step 5 stage and commit
 *     the issue-file move on the kanban side without a separate tool family.
 *
 * Both paths live on the same shared `globalThis.__pi_worktree_manager__`
 * stash that worktree-manager.ts populates at session_start.
 */

interface WorktreeManagerState {
  worktreePath?: string;       // per-issue worktree (set by worktree_prepare)
  kanbanWorktreePath?: string; // kanban worktree (set at session_start)
}

export interface ActiveWorktree {
  /** Absolute path to the active worktree. */
  cwd: string;
  /** Which worktree is active — informational, useful for tool result details. */
  target: "per-issue" | "kanban";
}

/**
 * Returns the active worktree the next git/run_tests call should target.
 * Returns `undefined` if neither worktree is set (extension not initialised).
 */
export function getActiveWorktree(): ActiveWorktree | undefined {
  const g = globalThis as { __pi_worktree_manager__?: WorktreeManagerState };
  const state = g.__pi_worktree_manager__;
  if (!state) return undefined;
  if (state.worktreePath) {
    return { cwd: state.worktreePath, target: "per-issue" };
  }
  if (state.kanbanWorktreePath) {
    return { cwd: state.kanbanWorktreePath, target: "kanban" };
  }
  return undefined;
}
