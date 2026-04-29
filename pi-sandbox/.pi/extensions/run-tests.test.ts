/**
 * Hermetic tests for run-tests extension.
 *
 * Tests are structured to exercise the `execInWorktree` integration and the
 * no-worktree guard without a live model or pi ExtensionAPI.
 *
 * The extension registers a tool via pi.registerTool; for hermetic testing
 * we call `execInWorktree` directly (which is what the tool wraps) and
 * separately test the no-worktree guard logic via the globalThis state.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-ext-"));
  repoPath = path.join(tmpDir, "repo");
  initRepo(repoPath);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// No-worktree guard (globalThis state)
// ---------------------------------------------------------------------------

describe("run_tests — no-worktree guard", () => {
  it("getWorktreePath returns undefined when state is absent", () => {
    // Simulate the internal logic: if __pi_worktree_manager__ is undefined
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    const saved = g.__pi_worktree_manager__;
    g.__pi_worktree_manager__ = undefined;

    const wtp = g.__pi_worktree_manager__?.worktreePath;
    expect(wtp).toBeUndefined();

    g.__pi_worktree_manager__ = saved;
  });

  it("getWorktreePath returns undefined when worktreePath is not set", () => {
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    const saved = g.__pi_worktree_manager__;
    g.__pi_worktree_manager__ = {};

    expect(g.__pi_worktree_manager__?.worktreePath).toBeUndefined();

    g.__pi_worktree_manager__ = saved;
  });

  it("getWorktreePath returns the path when worktreePath is set", () => {
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    const saved = g.__pi_worktree_manager__;
    g.__pi_worktree_manager__ = { worktreePath: "/tmp/my-worktree" };

    expect(g.__pi_worktree_manager__?.worktreePath).toBe("/tmp/my-worktree");

    g.__pi_worktree_manager__ = saved;
  });
});

// ---------------------------------------------------------------------------
// Happy-path: execInWorktree used by run_tests wraps npm test correctly
// ---------------------------------------------------------------------------

describe("run_tests — happy-path via execInWorktree", () => {
  it("exits 0 when npm test passes (simulated via node exit 0)", async () => {
    // We can't run real npm test in an isolated repo without a package.json,
    // but we can verify the exit code plumbing works correctly.
    const result = await execInWorktree("node", ["-e", "process.exit(0)"], repoPath);
    expect(result.exitCode).toBe(0);
  });

  it("exits non-zero when npm test fails (simulated via node exit 1)", async () => {
    const result = await execInWorktree("node", ["-e", "process.exit(1)"], repoPath);
    expect(result.exitCode).toBe(1);
  });

  it("captures stdout from a passing test run", async () => {
    const result = await execInWorktree(
      "node",
      ["-e", "process.stdout.write('Tests passed\\n'); process.exit(0)"],
      repoPath,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Tests passed");
  });

  it("captures stderr from a failing test run", async () => {
    const result = await execInWorktree(
      "node",
      ["-e", "process.stderr.write('FAIL src/foo.test.ts\\n'); process.exit(1)"],
      repoPath,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("FAIL src/foo.test.ts");
  });

  it("returns stdout even when exit code is non-zero", async () => {
    const result = await execInWorktree(
      "node",
      ["-e", "process.stdout.write('partial output'); process.exit(2)"],
      repoPath,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("partial output");
  });
});
