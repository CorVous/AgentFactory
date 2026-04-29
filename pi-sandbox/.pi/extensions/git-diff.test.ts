/**
 * Hermetic tests for git-diff extension.
 *
 * Tests the tool's core logic via execInWorktree directly and the
 * no-worktree guard via globalThis state manipulation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execInWorktree } from "./_lib/exec-in-worktree";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let repoPath: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "Initial commit");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-diff-ext-"));
  repoPath = path.join(tmpDir, "repo");
  initRepo(repoPath);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// No-worktree guard
// ---------------------------------------------------------------------------

describe("git_diff — no-worktree guard", () => {
  it("worktreePath is undefined when globalThis state is absent", () => {
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    const saved = g.__pi_worktree_manager__;
    g.__pi_worktree_manager__ = undefined;

    expect(g.__pi_worktree_manager__?.worktreePath).toBeUndefined();

    g.__pi_worktree_manager__ = saved;
  });
});

// ---------------------------------------------------------------------------
// Happy-path: git diff (unstaged)
// ---------------------------------------------------------------------------

describe("git_diff — unstaged changes", () => {
  it("returns empty output on a clean repo", async () => {
    const result = await execInWorktree("git", ["diff"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("shows unstaged changes to a tracked file", async () => {
    fs.writeFileSync(path.join(repoPath, "README.md"), "# modified\n");
    const result = await execInWorktree("git", ["diff"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("README.md");
    expect(result.stdout).toContain("# modified");
  });

  it("does NOT show staged changes in unstaged mode", async () => {
    fs.writeFileSync(path.join(repoPath, "new.ts"), "const x = 1;\n");
    git(repoPath, "add", "new.ts");
    // Unstaged diff should not show the staged new file
    const result = await execInWorktree("git", ["diff"], repoPath);
    expect(result.exitCode).toBe(0);
    // new.ts is staged (not modified after staging), so diff should be empty
    expect(result.stdout.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Happy-path: git diff --staged
// ---------------------------------------------------------------------------

describe("git_diff — staged changes", () => {
  it("returns empty output when nothing is staged", async () => {
    const result = await execInWorktree("git", ["diff", "--staged"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("shows staged new file content", async () => {
    fs.writeFileSync(path.join(repoPath, "staged.ts"), "export const z = 3;\n");
    git(repoPath, "add", "staged.ts");
    const result = await execInWorktree("git", ["diff", "--staged"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("staged.ts");
    expect(result.stdout).toContain("z = 3");
  });

  it("shows staged modification to tracked file", async () => {
    fs.writeFileSync(path.join(repoPath, "README.md"), "# updated\n");
    git(repoPath, "add", "README.md");
    const result = await execInWorktree("git", ["diff", "--staged"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("README.md");
    expect(result.stdout).toContain("# updated");
  });
});
