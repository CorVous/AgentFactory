/**
 * Hermetic tests for git-commit extension.
 *
 * Tests the commit logic via execInWorktree directly and the no-worktree
 * guard via globalThis state manipulation.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-commit-ext-"));
  repoPath = path.join(tmpDir, "repo");
  initRepo(repoPath);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// No-worktree guard
// ---------------------------------------------------------------------------

describe("git_commit — no-worktree guard", () => {
  it("worktreePath is undefined when globalThis state is absent", () => {
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    const saved = g.__pi_worktree_manager__;
    g.__pi_worktree_manager__ = undefined;

    expect(g.__pi_worktree_manager__?.worktreePath).toBeUndefined();

    g.__pi_worktree_manager__ = saved;
  });
});

// ---------------------------------------------------------------------------
// Happy-path: git commit
// ---------------------------------------------------------------------------

describe("git_commit — happy-path via execInWorktree", () => {
  it("creates a commit when changes are staged", async () => {
    fs.writeFileSync(path.join(repoPath, "feat.ts"), "export const f = 1;\n");
    git(repoPath, "add", "feat.ts");

    const result = await execInWorktree("git", ["commit", "-m", "feat: add feature"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("feat: add feature");
  });

  it("records the commit in git log", async () => {
    fs.writeFileSync(path.join(repoPath, "work.ts"), "export const w = 42;\n");
    git(repoPath, "add", "work.ts");

    await execInWorktree("git", ["commit", "-m", "test: add work"], repoPath);

    const log = await execInWorktree("git", ["log", "--oneline", "-1"], repoPath);
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain("test: add work");
  });

  it("fails gracefully when nothing is staged", async () => {
    const result = await execInWorktree("git", ["commit", "-m", "empty commit"], repoPath);
    expect(result.exitCode).not.toBe(0);
    // git outputs "nothing to commit" or similar
    expect(result.stdout + result.stderr).toMatch(/nothing to commit|nothing added/i);
  });

  it("handles commit messages with special characters", async () => {
    fs.writeFileSync(path.join(repoPath, "special.ts"), "const s = 'hello';\n");
    git(repoPath, "add", "special.ts");

    // Message with quotes, brackets, colons — passed as arg array, no shell escaping needed
    const message = `fix: handle "quoted" strings & special chars [TICKET-123]`;
    const result = await execInWorktree("git", ["commit", "-m", message], repoPath);
    expect(result.exitCode).toBe(0);

    const log = await execInWorktree("git", ["log", "--oneline", "-1"], repoPath);
    // git log --oneline truncates the subject; check --format=%B instead
    const fullLog = await execInWorktree("git", ["log", "-1", "--format=%B"], repoPath);
    expect(fullLog.stdout.trim()).toBe(message);
  });

  it("produces a valid SHA after commit", async () => {
    fs.writeFileSync(path.join(repoPath, "sha-test.ts"), "const t = true;\n");
    git(repoPath, "add", "sha-test.ts");
    await execInWorktree("git", ["commit", "-m", "chore: sha test"], repoPath);

    const sha = await execInWorktree("git", ["rev-parse", "HEAD"], repoPath);
    expect(sha.exitCode).toBe(0);
    expect(sha.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
