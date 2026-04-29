/**
 * Hermetic tests for getActiveWorktree fallback logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getActiveWorktree } from "./active-worktree";

interface WorktreeManagerState {
  worktreePath?: string;
  kanbanWorktreePath?: string;
}

function setState(state: WorktreeManagerState | undefined): void {
  const g = globalThis as { __pi_worktree_manager__?: WorktreeManagerState };
  g.__pi_worktree_manager__ = state;
}

describe("getActiveWorktree", () => {
  beforeEach(() => setState(undefined));

  it("returns undefined when no state is set", () => {
    expect(getActiveWorktree()).toBeUndefined();
  });

  it("returns kanban target when only kanbanWorktreePath is set", () => {
    setState({ kanbanWorktreePath: "/tmp/kanban" });
    expect(getActiveWorktree()).toEqual({ cwd: "/tmp/kanban", target: "kanban" });
  });

  it("returns per-issue target when worktreePath is set", () => {
    setState({ worktreePath: "/tmp/foreman-01", kanbanWorktreePath: "/tmp/kanban" });
    expect(getActiveWorktree()).toEqual({ cwd: "/tmp/foreman-01", target: "per-issue" });
  });

  it("falls back to kanban when worktreePath is cleared (post-dispose)", () => {
    setState({ worktreePath: "/tmp/foreman-01", kanbanWorktreePath: "/tmp/kanban" });
    expect(getActiveWorktree()?.target).toBe("per-issue");

    // Simulate worktree_dispose clearing the per-issue path.
    setState({ kanbanWorktreePath: "/tmp/kanban" });
    expect(getActiveWorktree()).toEqual({ cwd: "/tmp/kanban", target: "kanban" });
  });

  it("returns undefined when state has neither path", () => {
    setState({});
    expect(getActiveWorktree()).toBeUndefined();
  });
});
