// Regression test for the kanban scan-path bug.
//
// The Kanban is spawned with cwd: kanbanWorktreePath, which is a git worktree
// on feature/<slug>. Issue files live under .scratch/<slug>/issues/ on that
// branch — NOT on the project root's main checkout.
//
// Before the fix, scanIssueTree(feature, project) read from
// <project>/.scratch/<feature>/issues/ (project root = main checkout → empty).
// After the fix it reads from <cwd>/.scratch/<feature>/issues/ (kanban worktree
// = feature branch checkout → issues present).
//
// Tests are hermetic: real tmpdir git repos, no model calls, no network.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KANBAN_SCAN = path.join(HERE, "kanban-scan.mjs");

// Import the helper under test.  This import is at the top level so vitest
// will pick it up; the module must export `scanIssueTree(feature, scanRoot)`.
import { scanIssueTree } from "./kanban-scan.mjs";

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

const ISSUE_CONTENT = `Status: ready-for-agent

# Add add(a,b) function

- src/add.ts exporting add(a,b)
- src/add.test.ts with passing test
- npm test exits 0
`;

let tmpDir: string;
let projectPath: string;
let kanbanWorktreePath: string;
const FEATURE = "v1-fixture";

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "kanban-scan-test-"));
  projectPath = path.join(tmpDir, "project");
  mkdirSync(projectPath, { recursive: true });

  // Create main-branch repo
  makeRepo(projectPath);

  // Create feature branch with .scratch/<feature>/issues/01-foo.md
  git(["checkout", "-b", `feature/${FEATURE}`], projectPath);
  mkdirSync(path.join(projectPath, ".scratch", FEATURE, "issues"), { recursive: true });
  writeFileSync(
    path.join(projectPath, ".scratch", FEATURE, "issues", "01-add-function.md"),
    ISSUE_CONTENT,
  );
  git(["add", "."], projectPath);
  git(["commit", "-m", "feat: seed issue 01"], projectPath);

  // Return to main (project root stays on main — no .scratch directory here)
  git(["checkout", "main"], projectPath);

  // Create the kanban worktree on feature/<slug>
  kanbanWorktreePath = path.join(projectPath, ".mesh-features", FEATURE, "kanban");
  mkdirSync(path.dirname(kanbanWorktreePath), { recursive: true });
  git(["worktree", "add", kanbanWorktreePath, `feature/${FEATURE}`], projectPath);
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Core regression: scanning from the kanban worktree finds issues
// ---------------------------------------------------------------------------

describe("kanban scanIssueTree — scan-path regression", () => {
  it("finds the issue when scanRoot = kanban worktree (feature branch checkout)", () => {
    const issues = scanIssueTree(FEATURE, kanbanWorktreePath);
    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe("ready-for-agent");
    expect(issues[0].path).toContain("01-add-function.md");
  });

  it("returns [] when scanRoot = project root (main checkout, no .scratch dir)", () => {
    // This is the pre-fix behaviour that caused the bug: the project root is on
    // main, which has no .scratch/<feature>/issues/ directory.
    const issues = scanIssueTree(FEATURE, projectPath);
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Closed-subdirectory files are excluded
// ---------------------------------------------------------------------------

describe("kanban scanIssueTree — closed directory exclusion", () => {
  it("does not include .md files inside a closed/ subdirectory", () => {
    // Add a closed issue to the kanban worktree's feature branch.
    const closedDir = path.join(
      kanbanWorktreePath,
      ".scratch",
      FEATURE,
      "issues",
      "closed",
    );
    mkdirSync(closedDir, { recursive: true });
    writeFileSync(
      path.join(closedDir, "00-old.md"),
      "Status: done\n\n# Old issue\n",
    );

    const issues = scanIssueTree(FEATURE, kanbanWorktreePath);
    // Only the open issue should appear
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toContain("01-add-function.md");
  });
});
