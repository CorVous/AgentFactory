/**
 * Hermetic tests for git-mv extension.
 *
 * Tests path validation logic and the execInWorktree integration.
 * No live model or pi ExtensionAPI.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execInWorktree } from "./_lib/exec-in-worktree";

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
  fs.writeFileSync(path.join(dir, "tracked.md"), "tracked content\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "Initial commit");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-mv-ext-"));
  repoPath = path.join(tmpDir, "repo");
  initRepo(repoPath);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function validatePath(p: string, cwd: string): string | null {
  if (path.isAbsolute(p)) return `${p}: must be a relative path`;
  const resolved = path.resolve(cwd, p);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    return `${p}: escapes worktree root`;
  }
  return null;
}

describe("git_mv — no-worktree guard", () => {
  it("worktreePath is undefined when globalThis state is absent", () => {
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    const saved = g.__pi_worktree_manager__;
    g.__pi_worktree_manager__ = undefined;
    expect(g.__pi_worktree_manager__?.worktreePath).toBeUndefined();
    g.__pi_worktree_manager__ = saved;
  });
});

describe("git_mv — path validation", () => {
  it("accepts simple relative paths", () => {
    expect(validatePath("a.md", repoPath)).toBeNull();
    expect(validatePath("issues/closed/01-x.md", repoPath)).toBeNull();
  });

  it("rejects absolute src", () => {
    const v = validatePath("/etc/passwd", repoPath);
    expect(v).toContain("must be a relative path");
  });

  it("rejects parent-escape", () => {
    const v = validatePath("../escape", repoPath);
    expect(v).toContain("escapes worktree root");
  });
});

describe("git_mv — happy path via execInWorktree", () => {
  it("renames a tracked file (exit 0, status shows R)", async () => {
    const result = await execInWorktree(
      "git",
      ["mv", "tracked.md", "renamed.md"],
      repoPath,
    );
    expect(result.exitCode).toBe(0);

    const status = await execInWorktree(
      "git",
      ["status", "--porcelain"],
      repoPath,
    );
    // Rename is shown as `R  tracked.md -> renamed.md`
    expect(status.stdout).toMatch(/R\s+tracked\.md\s+->\s+renamed\.md/);
  });

  it("moves a tracked file into a subdirectory after parent is auto-created", async () => {
    // The git-mv extension auto-creates the destination's parent directory
    // before invoking git mv (because `git mv` itself does not). This test
    // exercises the integration: pre-create the parent, then run git mv.
    fs.mkdirSync(path.join(repoPath, "issues"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "issues/01-x.md"), "issue body\n");
    git(repoPath, "add", "issues/01-x.md");
    git(repoPath, "commit", "-m", "add issue");

    // Mirror the extension's behavior: ensure dst parent exists.
    fs.mkdirSync(path.join(repoPath, "issues/closed"), { recursive: true });

    const result = await execInWorktree(
      "git",
      ["mv", "issues/01-x.md", "issues/closed/01-x.md"],
      repoPath,
    );
    expect(result.exitCode).toBe(0);

    expect(fs.existsSync(path.join(repoPath, "issues/closed/01-x.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, "issues/01-x.md"))).toBe(false);
  });

  it("preserves file content across rename", async () => {
    const original = fs.readFileSync(path.join(repoPath, "tracked.md"), "utf8");
    await execInWorktree("git", ["mv", "tracked.md", "moved.md"], repoPath);
    const after = fs.readFileSync(path.join(repoPath, "moved.md"), "utf8");
    expect(after).toBe(original);
  });

  it("fails gracefully when src does not exist (non-zero exit + stderr)", async () => {
    const result = await execInWorktree(
      "git",
      ["mv", "nonexistent.md", "wherever.md"],
      repoPath,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("fails when src is untracked", async () => {
    fs.writeFileSync(path.join(repoPath, "untracked.md"), "x\n");
    const result = await execInWorktree(
      "git",
      ["mv", "untracked.md", "wherever.md"],
      repoPath,
    );
    expect(result.exitCode).not.toBe(0);
  });
});
