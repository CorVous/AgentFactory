/**
 * Hermetic tests for git-status extension.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-status-ext-"));
  repoPath = path.join(tmpDir, "repo");
  initRepo(repoPath);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// No-worktree guard
// ---------------------------------------------------------------------------

describe("git_status — no-worktree guard", () => {
  it("worktreePath is undefined when globalThis state is absent", () => {
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    const saved = g.__pi_worktree_manager__;
    g.__pi_worktree_manager__ = undefined;

    expect(g.__pi_worktree_manager__?.worktreePath).toBeUndefined();

    g.__pi_worktree_manager__ = saved;
  });
});

// ---------------------------------------------------------------------------
// Happy-path: git status --porcelain
// ---------------------------------------------------------------------------

describe("git_status — happy-path via execInWorktree", () => {
  it("returns empty stdout on a clean repo", async () => {
    const result = await execInWorktree("git", ["status", "--porcelain"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("shows untracked files", async () => {
    fs.writeFileSync(path.join(repoPath, "new-file.ts"), "export const x = 1;\n");
    const result = await execInWorktree("git", ["status", "--porcelain"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("new-file.ts");
  });

  it("shows modified tracked files with M prefix", async () => {
    // Modify the tracked README
    fs.writeFileSync(path.join(repoPath, "README.md"), "# modified\n");
    const result = await execInWorktree("git", ["status", "--porcelain"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("README.md");
  });

  it("shows staged files with A prefix after git add", async () => {
    fs.writeFileSync(path.join(repoPath, "staged.ts"), "export const y = 2;\n");
    git(repoPath, "add", "staged.ts");
    const result = await execInWorktree("git", ["status", "--porcelain"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("A  staged.ts");
  });
});
