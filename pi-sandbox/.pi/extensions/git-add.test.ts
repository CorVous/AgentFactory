/**
 * Hermetic tests for git-add extension.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-add-ext-"));
  repoPath = path.join(tmpDir, "repo");
  initRepo(repoPath);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// Path validation helpers (mirrors the extension's internal logic)
// ---------------------------------------------------------------------------

function validatePaths(cwd: string, paths: string[]): string[] {
  const violations: string[] = [];
  for (const p of paths) {
    if (path.isAbsolute(p)) {
      violations.push(`${p}: must be a relative path`);
      continue;
    }
    const resolved = path.resolve(cwd, p);
    if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
      violations.push(`${p}: escapes worktree root`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// No-worktree guard
// ---------------------------------------------------------------------------

describe("git_add — no-worktree guard", () => {
  it("worktreePath is undefined when globalThis state is absent", () => {
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    const saved = g.__pi_worktree_manager__;
    g.__pi_worktree_manager__ = undefined;

    expect(g.__pi_worktree_manager__?.worktreePath).toBeUndefined();

    g.__pi_worktree_manager__ = saved;
  });
});

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

describe("git_add — path validation", () => {
  it("accepts a simple relative path", () => {
    const violations = validatePaths(repoPath, ["src/foo.ts"]);
    expect(violations).toHaveLength(0);
  });

  it("accepts '.' (stage all)", () => {
    const violations = validatePaths(repoPath, ["."]);
    expect(violations).toHaveLength(0);
  });

  it("rejects absolute paths", () => {
    const violations = validatePaths(repoPath, ["/etc/passwd"]);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("must be a relative path");
  });

  it("rejects paths with .. that escape the root", () => {
    const violations = validatePaths(repoPath, ["../../etc/passwd"]);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("escapes worktree root");
  });

  it("accepts valid subdirectory path", () => {
    const violations = validatePaths(repoPath, ["sub/dir/file.ts"]);
    expect(violations).toHaveLength(0);
  });

  it("collects multiple violations", () => {
    const violations = validatePaths(repoPath, ["/abs/path", "../../escape"]);
    expect(violations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Happy-path: git add stages files correctly
// ---------------------------------------------------------------------------

describe("git_add — happy-path via execInWorktree", () => {
  it("stages a new file (exit 0, shows in status)", async () => {
    fs.writeFileSync(path.join(repoPath, "new.ts"), "export const x = 1;\n");
    const result = await execInWorktree("git", ["add", "new.ts"], repoPath);
    expect(result.exitCode).toBe(0);

    // Verify it's staged
    const status = await execInWorktree("git", ["status", "--porcelain"], repoPath);
    expect(status.stdout).toContain("A  new.ts");
  });

  it("stages all changes with '.'", async () => {
    fs.writeFileSync(path.join(repoPath, "a.ts"), "const a = 1;\n");
    fs.writeFileSync(path.join(repoPath, "b.ts"), "const b = 2;\n");
    const result = await execInWorktree("git", ["add", "."], repoPath);
    expect(result.exitCode).toBe(0);

    const status = await execInWorktree("git", ["status", "--porcelain"], repoPath);
    expect(status.stdout).toContain("a.ts");
    expect(status.stdout).toContain("b.ts");
  });

  it("fails gracefully on non-existent path (exit non-zero + stderr)", async () => {
    const result = await execInWorktree("git", ["add", "nonexistent.ts"], repoPath);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
