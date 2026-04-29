/**
 * Hermetic unit tests for worktree-manager.ts
 *
 * Uses a real tmpdir git repo — no model, no network, no env vars outside
 * the test's tmpdir. Abort-cleanup tests are deferred to #03b.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  issueBranchName,
  issueWorktreePath,
  prepareWorktree,
  reintegrate,
  disposeWorktree,
} from "./worktree-manager";

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Create a minimal git repo with an initial commit on `main`. */
function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test User");
  // Disable GPG signing so tests work in sandboxed CI environments
  git(dir, "config", "commit.gpgsign", "false");
  // Commit a placeholder file so the repo has an actual HEAD
  const readme = path.join(dir, "README.md");
  fs.writeFileSync(readme, "# test repo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "Initial commit");
}

/** Create `feature/<slug>` branch and add a kanban worktree at `<projectPath>/.mesh-features/<slug>/kanban/`. */
function setupKanbanWorktree(projectPath: string, featureSlug: string): string {
  const meshBranch = `feature/${featureSlug}`;
  git(projectPath, "branch", meshBranch);
  const kanbanPath = path.join(projectPath, ".mesh-features", featureSlug, "kanban");
  fs.mkdirSync(path.dirname(kanbanPath), { recursive: true });
  git(projectPath, "worktree", "add", kanbanPath, meshBranch);
  return kanbanPath;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let projectPath: string;
let featureSlug: string;
let meshBranch: string;
let kanbanPath: string;
let issuePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-test-"));
  projectPath = path.join(tmpDir, "project");
  featureSlug = "v1-ralph-loop-mesh";
  meshBranch = `feature/${featureSlug}`;
  issuePath = path.join(projectPath, ".scratch", featureSlug, "issues", "03-afk-trunk-end-to-end.md");

  initRepo(projectPath);
  kanbanPath = setupKanbanWorktree(projectPath, featureSlug);
});

afterEach(() => {
  // Best-effort cleanup — ignore errors (e.g. locked worktrees)
  try {
    // Remove any extra worktrees so git doesn't complain about them
    const wts = git(projectPath, "worktree", "list", "--porcelain")
      .split("\n\n")
      .map((block) => {
        const lines = block.trim().split("\n");
        return lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
      })
      .filter((p): p is string => !!p && p !== projectPath);

    for (const wt of wts) {
      try { git(projectPath, "worktree", "remove", "--force", wt); } catch { /* noop */ }
    }
  } catch { /* noop */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// issueBranchName
// ---------------------------------------------------------------------------

describe("issueBranchName", () => {
  it("derives branch name from mesh branch and issue path", () => {
    const result = issueBranchName(
      "feature/v1-ralph-loop-mesh",
      "/scratch/issues/03-afk-trunk-end-to-end.md",
    );
    expect(result).toBe("feature/v1-ralph-loop-mesh-03-afk-trunk-end-to-end");
  });

  it("handles nested issue path", () => {
    const result = issueBranchName(
      "feature/my-feature",
      "/project/.scratch/my-feature/issues/01-first-issue.md",
    );
    expect(result).toBe("feature/my-feature-01-first-issue");
  });

  it("strips prefix from mesh branch (e.g. 'feature/')", () => {
    const result = issueBranchName("feature/slug", "/issues/02-foo.md");
    expect(result).toMatch(/^feature\/slug-02-foo$/);
  });
});

// ---------------------------------------------------------------------------
// issueWorktreePath
// ---------------------------------------------------------------------------

describe("issueWorktreePath", () => {
  it("places worktree at <project>/.mesh-features/<slug>/foreman-<NN>-<slug>/", () => {
    const result = issueWorktreePath(
      "/projects/myapp",
      "feature/v1-ralph-loop-mesh",
      "/projects/myapp/.scratch/v1-ralph-loop-mesh/issues/03-afk-trunk-end-to-end.md",
    );
    expect(result).toBe(
      "/projects/myapp/.mesh-features/v1-ralph-loop-mesh/foreman-03-afk-trunk-end-to-end",
    );
  });
});

// ---------------------------------------------------------------------------
// prepareWorktree — branch creation
// ---------------------------------------------------------------------------

describe("prepareWorktree — branch naming and creation", () => {
  it("creates the per-issue branch off meshBranch", () => {
    const { branchName } = prepareWorktree(issuePath, projectPath, meshBranch, "auto-merge");

    expect(branchName).toBe(`feature/${featureSlug}-03-afk-trunk-end-to-end`);

    // Verify branch exists in the project repo
    const branches = git(projectPath, "branch", "--list", branchName);
    expect(branches).toContain(branchName);
  });

  it("returns the correct worktreePath", () => {
    const { worktreePath } = prepareWorktree(issuePath, projectPath, meshBranch, "auto-merge");

    const expected = path.join(projectPath, ".mesh-features", featureSlug, "foreman-03-afk-trunk-end-to-end");
    expect(worktreePath).toBe(expected);
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it("returns the mode passed in", () => {
    const { mode } = prepareWorktree(issuePath, projectPath, meshBranch, "auto-merge");
    expect(mode).toBe("auto-merge");
  });

  it("creates branch off the right base (meshBranch HEAD)", () => {
    // Add a commit on meshBranch via kanban worktree so it's ahead of main
    const testFile = path.join(kanbanPath, "mesh-marker.txt");
    fs.writeFileSync(testFile, "mesh work\n");
    git(kanbanPath, "add", "mesh-marker.txt");
    git(kanbanPath, "commit", "-m", "mesh work");

    const { worktreePath } = prepareWorktree(issuePath, projectPath, meshBranch, "auto-merge");

    // The per-issue worktree should have the mesh marker (branched off meshBranch)
    expect(fs.existsSync(path.join(worktreePath, "mesh-marker.txt"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reintegrate — AFK auto-merge
// ---------------------------------------------------------------------------

describe("reintegrate — AFK auto-merge", () => {
  it("merges per-issue branch into meshBranch and returns a mergedCommit SHA", () => {
    const { worktreePath } = prepareWorktree(issuePath, projectPath, meshBranch, "auto-merge");

    // Do some work in the per-issue worktree
    const newFile = path.join(worktreePath, "feature-work.ts");
    fs.writeFileSync(newFile, "export const x = 1;\n");
    git(worktreePath, "add", "feature-work.ts");
    git(worktreePath, "commit", "-m", "implement feature");

    const result = reintegrate(worktreePath, "auto-merge", meshBranch, kanbanPath);

    expect(result.mergedCommit).toBeDefined();
    expect(result.mergedCommit).toMatch(/^[0-9a-f]{40}$/);

    // Verify the file is now on meshBranch (in the kanban worktree)
    expect(fs.existsSync(path.join(kanbanPath, "feature-work.ts"))).toBe(true);
  });

  it("returns empty object for branch-emit mode", () => {
    const { worktreePath } = prepareWorktree(issuePath, projectPath, meshBranch, "branch-emit");

    const result = reintegrate(worktreePath, "branch-emit", meshBranch, kanbanPath);

    expect(result.mergedCommit).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// disposeWorktree — cleanup
// ---------------------------------------------------------------------------

describe("disposeWorktree — disposal", () => {
  it("removes the per-issue worktree directory", () => {
    // Need a commit on the branch before disposing
    const { worktreePath, branchName } = prepareWorktree(issuePath, projectPath, meshBranch, "auto-merge");

    // Add a commit so the branch has diverged (otherwise git may not need it)
    fs.writeFileSync(path.join(worktreePath, "work.txt"), "work\n");
    git(worktreePath, "add", "work.txt");
    git(worktreePath, "commit", "-m", "work");

    // Reintegrate first so the branch is merged (allows branch -D)
    reintegrate(worktreePath, "auto-merge", meshBranch, kanbanPath);

    disposeWorktree(worktreePath, projectPath);

    expect(fs.existsSync(worktreePath)).toBe(false);

    // Branch should also be deleted (it was merged, so -D still works)
    const branches = git(projectPath, "branch", "--list", branchName);
    expect(branches.trim()).toBe("");
  });

  it("removes the worktree without error even if work is uncommitted (#03b tests abort-cleanup)", () => {
    // This just verifies --force works for the happy path
    const { worktreePath, branchName } = prepareWorktree(issuePath, projectPath, meshBranch, "auto-merge");

    // Do NOT commit anything — worktree has no divergent commits
    disposeWorktree(worktreePath, projectPath);

    expect(fs.existsSync(worktreePath)).toBe(false);
    // Branch should be deleted (no commits, so -D is safe)
    const branches = git(projectPath, "branch", "--list", branchName);
    expect(branches.trim()).toBe("");
  });
});
