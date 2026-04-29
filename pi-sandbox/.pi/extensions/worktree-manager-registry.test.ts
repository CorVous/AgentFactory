/**
 * Hermetic tests verifying that worktree-manager registers and unregisters
 * the per-issue worktree path in the sandbox root registry.
 *
 * These tests exercise:
 *   1. registerSandboxRoot / unregisterSandboxRoot from sandbox.ts
 *   2. The globalThis.__pi_worktree_manager__ state pattern used by the
 *      git tool extensions to locate the worktree path.
 *
 * No live model or pi ExtensionAPI — pure in-process logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { registerSandboxRoot, unregisterSandboxRoot } from "./deferred/sandbox";
import path from "node:path";

// Reset the globalThis registries between tests.
function clearAll(): void {
  globalThis.__pi_sandbox_allowed_roots__ = [];
  const g = globalThis as { __pi_worktree_manager__?: unknown };
  g.__pi_worktree_manager__ = undefined;
}

beforeEach(() => {
  clearAll();
});

// ---------------------------------------------------------------------------
// Simulate worktree_prepare hook: registerSandboxRoot
// ---------------------------------------------------------------------------

describe("worktree_prepare → registerSandboxRoot", () => {
  it("registers the worktree path so it appears in the allowed roots", () => {
    const worktreePath = "/tmp/project/.mesh-features/my-slug/foreman-03-issue";
    registerSandboxRoot(worktreePath);

    expect(globalThis.__pi_sandbox_allowed_roots__).toContain(path.resolve(worktreePath));
  });

  it("does not add duplicates if prepare is called twice with the same path", () => {
    const worktreePath = "/tmp/project/.mesh-features/my-slug/foreman-03-issue";
    registerSandboxRoot(worktreePath);
    registerSandboxRoot(worktreePath);

    const count = globalThis.__pi_sandbox_allowed_roots__!.filter(
      (r) => r === path.resolve(worktreePath),
    ).length;
    expect(count).toBe(1);
  });

  it("registers multiple distinct worktrees (parallel foremen)", () => {
    const wt1 = "/tmp/project/.mesh-features/slug-a/foreman-01-first";
    const wt2 = "/tmp/project/.mesh-features/slug-a/foreman-02-second";
    registerSandboxRoot(wt1);
    registerSandboxRoot(wt2);

    expect(globalThis.__pi_sandbox_allowed_roots__).toContain(path.resolve(wt1));
    expect(globalThis.__pi_sandbox_allowed_roots__).toContain(path.resolve(wt2));
    expect(globalThis.__pi_sandbox_allowed_roots__!.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Simulate worktree_dispose hook: unregisterSandboxRoot
// ---------------------------------------------------------------------------

describe("worktree_dispose → unregisterSandboxRoot", () => {
  it("removes the worktree path after dispose", () => {
    const worktreePath = "/tmp/project/.mesh-features/my-slug/foreman-03-issue";
    registerSandboxRoot(worktreePath);
    expect(globalThis.__pi_sandbox_allowed_roots__).toContain(path.resolve(worktreePath));

    unregisterSandboxRoot(worktreePath);
    expect(globalThis.__pi_sandbox_allowed_roots__).not.toContain(path.resolve(worktreePath));
  });

  it("does not affect other registered roots after unregister", () => {
    const wt1 = "/tmp/project/.mesh-features/slug/foreman-01";
    const wt2 = "/tmp/project/.mesh-features/slug/foreman-02";
    registerSandboxRoot(wt1);
    registerSandboxRoot(wt2);

    unregisterSandboxRoot(wt1);

    expect(globalThis.__pi_sandbox_allowed_roots__).not.toContain(path.resolve(wt1));
    expect(globalThis.__pi_sandbox_allowed_roots__).toContain(path.resolve(wt2));
  });

  it("is a no-op when path was never registered", () => {
    expect(() => unregisterSandboxRoot("/tmp/not-registered")).not.toThrow();
    expect(globalThis.__pi_sandbox_allowed_roots__!.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: prepare → dispose
// ---------------------------------------------------------------------------

describe("prepare → dispose round-trip", () => {
  it("registry is empty after registering and unregistering the same path", () => {
    const worktreePath = "/tmp/project/.mesh-features/v1/foreman-03-test";
    registerSandboxRoot(worktreePath);
    unregisterSandboxRoot(worktreePath);
    expect(globalThis.__pi_sandbox_allowed_roots__!.length).toBe(0);
  });

  it("supports multiple prepare/dispose cycles on the same path", () => {
    const worktreePath = "/tmp/project/.mesh-features/v1/foreman-03-test";
    for (let i = 0; i < 3; i++) {
      registerSandboxRoot(worktreePath);
      expect(globalThis.__pi_sandbox_allowed_roots__!.length).toBe(1);
      unregisterSandboxRoot(worktreePath);
      expect(globalThis.__pi_sandbox_allowed_roots__!.length).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// globalThis.__pi_worktree_manager__ state pattern
// (mirrors the pattern used by run-tests, git-status, git-diff, git-add, git-commit)
// ---------------------------------------------------------------------------

describe("globalThis worktree state — git tool extensions pattern", () => {
  it("returns undefined when state is not set", () => {
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    expect(g.__pi_worktree_manager__?.worktreePath).toBeUndefined();
  });

  it("returns the worktreePath when set (simulating worktree_prepare success)", () => {
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    g.__pi_worktree_manager__ = { worktreePath: "/tmp/my-worktree" };
    expect(g.__pi_worktree_manager__?.worktreePath).toBe("/tmp/my-worktree");
  });

  it("returns undefined after worktreePath is cleared (simulating worktree_dispose)", () => {
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    g.__pi_worktree_manager__ = { worktreePath: "/tmp/my-worktree" };
    g.__pi_worktree_manager__!.worktreePath = undefined;
    expect(g.__pi_worktree_manager__?.worktreePath).toBeUndefined();
  });

  it("registry and state are consistent when both are managed together", () => {
    const wtp = "/tmp/project/.mesh-features/v1/foreman-03-test";

    // Simulate worktree_prepare
    const g = globalThis as { __pi_worktree_manager__?: { worktreePath?: string } };
    g.__pi_worktree_manager__ = { worktreePath: wtp };
    registerSandboxRoot(wtp);

    expect(g.__pi_worktree_manager__?.worktreePath).toBe(wtp);
    expect(globalThis.__pi_sandbox_allowed_roots__).toContain(path.resolve(wtp));

    // Simulate worktree_dispose
    unregisterSandboxRoot(wtp);
    g.__pi_worktree_manager__!.worktreePath = undefined;

    expect(g.__pi_worktree_manager__?.worktreePath).toBeUndefined();
    expect(globalThis.__pi_sandbox_allowed_roots__).not.toContain(path.resolve(wtp));
  });
});
