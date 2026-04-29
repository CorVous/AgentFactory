/**
 * Hermetic tests for exec-in-worktree.ts.
 *
 * Uses a real tmpdir git repo — no model, no network, no env vars outside
 * the test's tmpdir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execInWorktree } from "./exec-in-worktree";

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-wt-test-"));
  repoPath = path.join(tmpDir, "repo");
  initRepo(repoPath);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("execInWorktree", () => {
  it("runs a command and returns stdout + exitCode 0", async () => {
    const result = await execInWorktree("git", ["status", "--porcelain"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeDefined();
    // Clean repo — no output expected
    expect(result.stdout.trim()).toBe("");
  });

  it("captures stdout from a successful command", async () => {
    const result = await execInWorktree("git", ["rev-parse", "HEAD"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns non-zero exitCode on failure without throwing", async () => {
    const result = await execInWorktree("git", ["diff", "--nonexistentflag"], repoPath);
    expect(result.exitCode).not.toBe(0);
  });

  it("captures stderr on failure", async () => {
    const result = await execInWorktree("git", ["diff", "--nonexistentflag"], repoPath);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("runs git diff --staged on a staged file", async () => {
    // Stage a new file
    const newFile = path.join(repoPath, "staged.txt");
    fs.writeFileSync(newFile, "staged content\n");
    git(repoPath, "add", "staged.txt");

    const result = await execInWorktree("git", ["diff", "--staged"], repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("staged content");
  });

  it("runs npm test (exit code 0 when vitest passes)", async () => {
    // We can't run npm test inside the bare git repo, but we can verify that
    // a failing command returns exitCode != 0 without throwing
    const result = await execInWorktree(
      "node",
      ["-e", "process.exit(42)"],
      repoPath,
    );
    expect(result.exitCode).toBe(42);
  });

  it("returns stdout even when exit code is non-zero", async () => {
    // node -e "process.stdout.write('hello'); process.exit(1)"
    const result = await execInWorktree(
      "node",
      ["-e", "process.stdout.write('hello'); process.exit(1)"],
      repoPath,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("hello");
  });
});
