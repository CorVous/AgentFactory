// Tests for the per-issue Worktree manager.
// Hermetic: pure-function tests run without a real repo;
// git integration tests use a real tmpdir git repo.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  parseIssueNN,
  parseIssueSlug,
  featureSlugFromBranch,
  decideBranchName,
  decidePath,
  decideMode,
  prepareWorktree,
  disposeWorktree,
  reintegrate,
  abortAndCleanup,
} from "./worktree-manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function makeRepo(dir: string, initialBranch = "main"): string {
  git(["init", "-b", initialBranch, dir], os.tmpdir());
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  // Disable commit signing for hermetic test repos.
  git(["config", "commit.gpgsign", "false"], dir);
  // Create an initial commit so the branch exists.
  writeFileSync(path.join(dir, "README.md"), "initial");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

function makeFeatureBranch(projectPath: string, branchName: string): void {
  git(["checkout", "-b", branchName], projectPath);
  git(["checkout", "main"], projectPath);
}

function makeIssueFile(
  projectPath: string,
  relPath: string,
  status: string,
): string {
  const fullPath = path.join(projectPath, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(
    fullPath,
    `Status: ${status}\n\n# Test Issue\n\nBody text.\n`,
  );
  return fullPath;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "wt-mgr-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseIssueNN", () => {
  it("extracts NN from a path like .scratch/feat/issues/03-foo.md", () => {
    expect(parseIssueNN(".scratch/feat/issues/03-afk-trunk.md")).toBe("03");
  });

  it("returns empty string for a non-matching path", () => {
    expect(parseIssueNN("README.md")).toBe("");
  });
});

describe("parseIssueSlug", () => {
  it("extracts slug from .scratch/feat/issues/03-afk-trunk-end-to-end.md", () => {
    expect(parseIssueSlug(".scratch/feat/issues/03-afk-trunk-end-to-end.md")).toBe(
      "afk-trunk-end-to-end",
    );
  });

  it("returns empty string for a non-matching basename", () => {
    expect(parseIssueSlug("README.md")).toBe("");
  });
});

describe("featureSlugFromBranch", () => {
  it("strips the feature/ prefix", () => {
    expect(featureSlugFromBranch("feature/v1-ralph-loop-mesh")).toBe(
      "v1-ralph-loop-mesh",
    );
  });

  it("passes through a branch that has no feature/ prefix", () => {
    expect(featureSlugFromBranch("main")).toBe("main");
  });
});

describe("decideBranchName", () => {
  it("combines meshBranch, NN, and slug correctly", () => {
    expect(
      decideBranchName(
        ".scratch/v1-ralph-loop-mesh/issues/03-afk-trunk-end-to-end.md",
        "feature/v1-ralph-loop-mesh",
      ),
    ).toBe("feature/v1-ralph-loop-mesh-03-afk-trunk-end-to-end");
  });

  it("works with a different feature slug and NN", () => {
    expect(
      decideBranchName(
        ".scratch/other-feat/issues/01-kanban-script.md",
        "feature/other-feat",
      ),
    ).toBe("feature/other-feat-01-kanban-script");
  });
});

describe("decidePath", () => {
  it("builds the correct worktree path", () => {
    const result = decidePath(
      ".scratch/v1-ralph-loop-mesh/issues/03-afk-trunk-end-to-end.md",
      "/tmp/proj",
      "feature/v1-ralph-loop-mesh",
    );
    expect(result).toBe(
      "/tmp/proj/.mesh-features/v1-ralph-loop-mesh/foreman-03-afk-trunk-end-to-end",
    );
  });
});

describe("decideMode (pure read)", () => {
  it("returns auto-merge for Status: ready-for-agent", () => {
    const projectPath = mkdtempSync(path.join(os.tmpdir(), "dm-test-"));
    try {
      makeIssueFile(
        projectPath,
        ".scratch/feat/issues/01-foo.md",
        "ready-for-agent",
      );
      expect(
        decideMode(".scratch/feat/issues/01-foo.md", projectPath),
      ).toBe("auto-merge");
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("returns branch-emit for Status: ready-for-human", () => {
    const projectPath = mkdtempSync(path.join(os.tmpdir(), "dm-test-"));
    try {
      makeIssueFile(
        projectPath,
        ".scratch/feat/issues/01-foo.md",
        "ready-for-human",
      );
      expect(
        decideMode(".scratch/feat/issues/01-foo.md", projectPath),
      ).toBe("branch-emit");
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("throws for a non-workable status", () => {
    const projectPath = mkdtempSync(path.join(os.tmpdir(), "dm-test-"));
    try {
      makeIssueFile(projectPath, ".scratch/feat/issues/01-foo.md", "needs-triage");
      expect(() =>
        decideMode(".scratch/feat/issues/01-foo.md", projectPath),
      ).toThrow(/non-workable status/);
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Git integration: prepareWorktree
// ---------------------------------------------------------------------------

describe("prepareWorktree — git integration", () => {
  it("returns the right branchName derived from meshBranch + issue path", () => {
    const projectPath = path.join(tmpDir, "proj");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);
    makeFeatureBranch(projectPath, "feature/my-feat");
    makeIssueFile(projectPath, ".scratch/my-feat/issues/01-do-thing.md", "ready-for-agent");
    git(["add", "."], projectPath);
    git(["commit", "-m", "add issue"], projectPath);
    // Fast-forward feature branch to include the issue file commit
    git(["checkout", "feature/my-feat"], projectPath);
    git(["merge", "--ff-only", "main"], projectPath);
    git(["checkout", "main"], projectPath);

    const result = prepareWorktree(
      ".scratch/my-feat/issues/01-do-thing.md",
      projectPath,
      "feature/my-feat",
    );
    expect(result.branchName).toBe("feature/my-feat-01-do-thing");
    rmSync(result.worktreePath, { recursive: true, force: true });
    git(["worktree", "prune"], projectPath);
    git(["branch", "-D", result.branchName], projectPath);
  });

  it("returns mode: auto-merge for ready-for-agent", () => {
    const projectPath = path.join(tmpDir, "proj2");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);
    makeFeatureBranch(projectPath, "feature/f2");
    makeIssueFile(projectPath, ".scratch/f2/issues/02-foo.md", "ready-for-agent");
    git(["add", "."], projectPath);
    git(["commit", "-m", "issue"], projectPath);
    git(["checkout", "feature/f2"], projectPath);
    git(["merge", "--ff-only", "main"], projectPath);
    git(["checkout", "main"], projectPath);

    const result = prepareWorktree(
      ".scratch/f2/issues/02-foo.md",
      projectPath,
      "feature/f2",
    );
    expect(result.mode).toBe("auto-merge");
    rmSync(result.worktreePath, { recursive: true, force: true });
    git(["worktree", "prune"], projectPath);
    git(["branch", "-D", result.branchName], projectPath);
  });

  it("returns mode: branch-emit for ready-for-human", () => {
    const projectPath = path.join(tmpDir, "proj3");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);
    makeFeatureBranch(projectPath, "feature/f3");
    makeIssueFile(projectPath, ".scratch/f3/issues/03-bar.md", "ready-for-human");
    git(["add", "."], projectPath);
    git(["commit", "-m", "issue"], projectPath);
    git(["checkout", "feature/f3"], projectPath);
    git(["merge", "--ff-only", "main"], projectPath);
    git(["checkout", "main"], projectPath);

    const result = prepareWorktree(
      ".scratch/f3/issues/03-bar.md",
      projectPath,
      "feature/f3",
    );
    expect(result.mode).toBe("branch-emit");
    rmSync(result.worktreePath, { recursive: true, force: true });
    git(["worktree", "prune"], projectPath);
    git(["branch", "-D", result.branchName], projectPath);
  });

  it("actually creates the worktree at the right path on a fresh branch", () => {
    const projectPath = path.join(tmpDir, "proj4");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);
    makeFeatureBranch(projectPath, "feature/f4");
    makeIssueFile(projectPath, ".scratch/f4/issues/01-create-me.md", "ready-for-agent");
    git(["add", "."], projectPath);
    git(["commit", "-m", "issue"], projectPath);
    git(["checkout", "feature/f4"], projectPath);
    git(["merge", "--ff-only", "main"], projectPath);
    git(["checkout", "main"], projectPath);

    const result = prepareWorktree(
      ".scratch/f4/issues/01-create-me.md",
      projectPath,
      "feature/f4",
    );
    // Verify worktree dir exists and has a .git file
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(existsSync(path.join(result.worktreePath, ".git"))).toBe(true);

    // Verify the branch exists in git
    const branches = git(["branch", "--list", result.branchName], projectPath);
    expect(branches).toContain(result.branchName);

    // Cleanup
    rmSync(result.worktreePath, { recursive: true, force: true });
    git(["worktree", "prune"], projectPath);
    git(["branch", "-D", result.branchName], projectPath);
  });
});

// ---------------------------------------------------------------------------
// Git integration: disposeWorktree
// ---------------------------------------------------------------------------

describe("disposeWorktree — git integration", () => {
  it("removes the worktree", async () => {
    const projectPath = path.join(tmpDir, "proj-dispose");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);
    makeFeatureBranch(projectPath, "feature/fd");
    makeIssueFile(projectPath, ".scratch/fd/issues/01-disp.md", "ready-for-agent");
    git(["add", "."], projectPath);
    git(["commit", "-m", "issue"], projectPath);
    git(["checkout", "feature/fd"], projectPath);
    git(["merge", "--ff-only", "main"], projectPath);
    git(["checkout", "main"], projectPath);

    const result = prepareWorktree(
      ".scratch/fd/issues/01-disp.md",
      projectPath,
      "feature/fd",
    );

expect(existsSync(result.worktreePath)).toBe(true);

    disposeWorktree(result.worktreePath);

    expect(existsSync(result.worktreePath)).toBe(false);
    git(["branch", "-D", result.branchName], projectPath);
  });
});

// ---------------------------------------------------------------------------
// Git integration: reintegrate — AFK auto-merge
// ---------------------------------------------------------------------------

describe("reintegrate — AFK auto-merge (git integration)", () => {
  it("ff-only merges the per-issue branch into the mesh branch when possible", async () => {
    const projectPath = path.join(tmpDir, "proj-reint-ff");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);
    makeFeatureBranch(projectPath, "feature/ri");
    makeIssueFile(projectPath, ".scratch/ri/issues/01-x.md", "ready-for-agent");
    git(["add", "."], projectPath);
    git(["commit", "-m", "issue"], projectPath);
    git(["checkout", "feature/ri"], projectPath);
    git(["merge", "--ff-only", "main"], projectPath);
    git(["checkout", "main"], projectPath);

    // Create per-issue worktree and add a commit to it
    const result = prepareWorktree(
      ".scratch/ri/issues/01-x.md",
      projectPath,
      "feature/ri",
    );
    writeFileSync(path.join(result.worktreePath, "work.txt"), "done");
    git(["add", "."], result.worktreePath);
    git(["commit", "-m", "feat: work done"], result.worktreePath);

    // Set up kanban worktree on the mesh branch
    const kanbanPath = path.join(tmpDir, "kanban-ri");
    mkdirSync(kanbanPath, { recursive: true });
    git(["worktree", "add", kanbanPath, "feature/ri"], projectPath);

    const reintResult = reintegrate(result.worktreePath, "auto-merge", "feature/ri", kanbanPath);

    expect(reintResult.mergedCommit).toBeDefined();
    expect(typeof reintResult.mergedCommit).toBe("string");
    expect(reintResult.mergedCommit!.length).toBeGreaterThan(0);

    // Verify the commit landed on the mesh branch
    const headOnMesh = git(["rev-parse", "HEAD"], kanbanPath);
    expect(headOnMesh).toBe(reintResult.mergedCommit);

expect(existsSync(path.join(kanbanPath, "work.txt"))).toBe(true);

    rmSync(result.worktreePath, { recursive: true, force: true });
    rmSync(kanbanPath, { recursive: true, force: true });
    git(["worktree", "prune"], projectPath);
    git(["branch", "-D", result.branchName], projectPath);
    git(["worktree", "prune"], projectPath);
  });

  it("falls back to merge commit when ff-only is not possible", async () => {
    const projectPath = path.join(tmpDir, "proj-reint-mc");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);
    makeFeatureBranch(projectPath, "feature/ri2");
    makeIssueFile(projectPath, ".scratch/ri2/issues/01-y.md", "ready-for-agent");
    git(["add", "."], projectPath);
    git(["commit", "-m", "issue"], projectPath);
    git(["checkout", "feature/ri2"], projectPath);
    git(["merge", "--ff-only", "main"], projectPath);
    git(["checkout", "main"], projectPath);

    // Create per-issue worktree
    const result = prepareWorktree(
      ".scratch/ri2/issues/01-y.md",
      projectPath,
      "feature/ri2",
    );
    writeFileSync(path.join(result.worktreePath, "work.txt"), "done");
    git(["add", "."], result.worktreePath);
    git(["commit", "-m", "feat: work done"], result.worktreePath);

    // Set up kanban worktree on the mesh branch; add a DIVERGING commit
    const kanbanPath = path.join(tmpDir, "kanban-ri2");
    mkdirSync(kanbanPath, { recursive: true });
    git(["worktree", "add", kanbanPath, "feature/ri2"], projectPath);
    writeFileSync(path.join(kanbanPath, "diverge.txt"), "mesh-side change");
    git(["add", "."], kanbanPath);
    git(["commit", "-m", "chore: mesh-side diverge"], kanbanPath);

    // Now ff-only would fail — fall back to merge commit
    const reintResult = reintegrate(result.worktreePath, "auto-merge", "feature/ri2", kanbanPath);
    expect(reintResult.mergedCommit).toBeDefined();

expect(existsSync(path.join(kanbanPath, "work.txt"))).toBe(true);
    expect(existsSync(path.join(kanbanPath, "diverge.txt"))).toBe(true);

    rmSync(result.worktreePath, { recursive: true, force: true });
    rmSync(kanbanPath, { recursive: true, force: true });
    git(["worktree", "prune"], projectPath);
    git(["branch", "-D", result.branchName], projectPath);
    git(["worktree", "prune"], projectPath);
  });

  it("HITL mode is a no-op — returns {} and leaves worktree + branch in place", async () => {
    const projectPath = path.join(tmpDir, "proj-reint-hitl");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);
    makeFeatureBranch(projectPath, "feature/ri3");
    makeIssueFile(projectPath, ".scratch/ri3/issues/01-z.md", "ready-for-human");
    git(["add", "."], projectPath);
    git(["commit", "-m", "issue"], projectPath);
    git(["checkout", "feature/ri3"], projectPath);
    git(["merge", "--ff-only", "main"], projectPath);
    git(["checkout", "main"], projectPath);

    const result = prepareWorktree(
      ".scratch/ri3/issues/01-z.md",
      projectPath,
      "feature/ri3",
    );

    const kanbanPath = path.join(tmpDir, "kanban-ri3");
    mkdirSync(kanbanPath, { recursive: true });
    git(["worktree", "add", kanbanPath, "feature/ri3"], projectPath);

    const hitlResult = reintegrate(result.worktreePath, "branch-emit", "feature/ri3", kanbanPath);
    expect(hitlResult).toEqual({});

    // Worktree and branch still exist
expect(existsSync(result.worktreePath)).toBe(true);

    // Cleanup
    rmSync(result.worktreePath, { recursive: true, force: true });
    rmSync(kanbanPath, { recursive: true, force: true });
    git(["worktree", "prune"], projectPath);
    git(["branch", "-D", result.branchName], projectPath);
    git(["worktree", "prune"], projectPath);
  });
});

// ---------------------------------------------------------------------------
// Git integration: abortAndCleanup
// ---------------------------------------------------------------------------

describe("abortAndCleanup — git integration", () => {
  it("disposes the worktree and deletes the per-issue branch ref", async () => {
    const projectPath = path.join(tmpDir, "proj-abort");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);
    makeFeatureBranch(projectPath, "feature/ab");
    makeIssueFile(projectPath, ".scratch/ab/issues/01-abort.md", "ready-for-agent");
    git(["add", "."], projectPath);
    git(["commit", "-m", "issue"], projectPath);
    git(["checkout", "feature/ab"], projectPath);
    git(["merge", "--ff-only", "main"], projectPath);
    git(["checkout", "main"], projectPath);

    const result = prepareWorktree(
      ".scratch/ab/issues/01-abort.md",
      projectPath,
      "feature/ab",
    );

expect(existsSync(result.worktreePath)).toBe(true);

    abortAndCleanup(result.worktreePath, result.branchName);

    // Worktree removed
    expect(existsSync(result.worktreePath)).toBe(false);

    // Branch ref deleted
    const branches = git(["branch", "--list", result.branchName], projectPath);
    expect(branches.trim()).toBe("");
  });
});
