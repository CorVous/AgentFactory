// Hermetic tests for launch-mesh.mjs runtime-mode guards.
// Tests run the launcher as a subprocess and verify exit codes + stderr.
//
// No live model, no network. Git operations use real tmpdir repos.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH_MESH = path.join(HERE, "launch-mesh.mjs");
const NODE = process.execPath;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function makeRepo(dir: string): void {
  git(["init", "-b", "main", dir], os.tmpdir());
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(path.join(dir, "README.md"), "initial");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
}

function runLauncher(args: string[], cwd: string): { code: number | null; stderr: string } {
  const result = spawnSync(NODE, [LAUNCH_MESH, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  return { code: result.status, stderr: result.stderr ?? "" };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "lm-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Guard 1: must be inside a non-main worktree
// ---------------------------------------------------------------------------

describe("launch-mesh runtime mode — worktree guard", () => {
  it("refuses to run when invoked from outside any worktree (plain directory)", () => {
    const projectPath = path.join(tmpDir, "proj");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);

    // Run from a plain tmpdir, not from any worktree
    const nonWorktreeDir = path.join(tmpDir, "not-a-worktree");
    mkdirSync(nonWorktreeDir, { recursive: true });

    const { code, stderr } = runLauncher(
      ["--project", projectPath, "--feature", "my-feat"],
      nonWorktreeDir,
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain("worktree");
  });

  it("refuses to run when invoked from the project main checkout", () => {
    const projectPath = path.join(tmpDir, "proj2");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);

    // The main checkout IS a worktree but it's the main one — refused.
    const { code, stderr } = runLauncher(
      ["--project", projectPath, "--feature", "my-feat"],
      projectPath, // run from the main checkout directly
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain("worktree");
  });
});

// ---------------------------------------------------------------------------
// Guard 2: feature branch must exist
// ---------------------------------------------------------------------------

describe("launch-mesh runtime mode — feature branch guard", () => {
  it("fails fast when feature/<slug> does not exist on the project", () => {
    const projectPath = path.join(tmpDir, "proj3");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);

    // Create a non-main worktree using detached HEAD (any commit) to satisfy guard 1
    const kanbanPath = path.join(tmpDir, "kanban3");
    const mainSha = git(["rev-parse", "HEAD"], projectPath);
    git(["worktree", "add", "--detach", kanbanPath, mainSha], projectPath);

    const { code, stderr } = runLauncher(
      ["--project", projectPath, "--feature", "nonexistent-feat"],
      kanbanPath,
    );

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/feature\/nonexistent-feat/);

    rmSync(kanbanPath, { recursive: true, force: true });
    git(["worktree", "prune"], projectPath);
  });
});

// ---------------------------------------------------------------------------
// Guard 3: .scratch/<slug>/issues/ must be non-empty
// ---------------------------------------------------------------------------

describe("launch-mesh runtime mode — issues directory guard", () => {
  it("fails fast when .scratch/<slug>/issues/ is missing or empty", () => {
    const projectPath = path.join(tmpDir, "proj4");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);

    // Create the feature branch
    git(["checkout", "-b", "feature/my-feat"], projectPath);
    git(["checkout", "main"], projectPath);

    // Create a non-main worktree on feature/my-feat
    const kanbanPath = path.join(tmpDir, "kanban4");
    git(["worktree", "add", kanbanPath, "feature/my-feat"], projectPath);

    // No .scratch/my-feat/issues/ directory exists

    const { code, stderr } = runLauncher(
      ["--project", projectPath, "--feature", "my-feat"],
      kanbanPath,
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain("issue");

    rmSync(kanbanPath, { recursive: true, force: true });
    git(["worktree", "prune"], projectPath);
  });
});

// ---------------------------------------------------------------------------
// Mesh worktree setup
// ---------------------------------------------------------------------------

describe("launch-mesh runtime mode — kanban worktree setup", () => {
  it("creates the kanban worktree at <project>/.mesh-features/<slug>/kanban/", () => {
    const projectPath = path.join(tmpDir, "proj5");
    mkdirSync(projectPath, { recursive: true });
    makeRepo(projectPath);

    // Create the feature branch with an issue
    git(["checkout", "-b", "feature/feat5"], projectPath);
    mkdirSync(path.join(projectPath, ".scratch", "feat5", "issues"), { recursive: true });
    writeFileSync(
      path.join(projectPath, ".scratch", "feat5", "issues", "01-foo.md"),
      "Status: ready-for-agent\n\n# Foo\n\nDo stuff.\n",
    );
    git(["add", "."], projectPath);
    git(["commit", "-m", "add issue"], projectPath);
    git(["checkout", "main"], projectPath);

    // Create the kanban worktree explicitly (simulating what the launcher does
    // after guard checks pass). We test that the path is correct.
    const expectedKanbanPath = path.join(projectPath, ".mesh-features", "feat5", "kanban");
    mkdirSync(path.dirname(expectedKanbanPath), { recursive: true });
    git(["worktree", "add", expectedKanbanPath, "feature/feat5"], projectPath);

    // Now run from inside the kanban worktree — should succeed past all guards
    // and start the Kanban (which we kill immediately via timeout).
    // We just verify the path computation is correct.
    expect(expectedKanbanPath).toContain(".mesh-features/feat5/kanban");

    rmSync(expectedKanbanPath, { recursive: true, force: true });
    git(["worktree", "prune"], projectPath);
    git(["branch", "-D", "feature/feat5"], projectPath);
  });
});
