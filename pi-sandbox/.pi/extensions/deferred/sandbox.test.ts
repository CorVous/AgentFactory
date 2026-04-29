/**
 * Unit tests for the sandbox runtime-root registry.
 *
 * These tests are hermetic: no model, no pi ExtensionAPI, no network.
 * They import the exported helpers directly and exercise the globalThis
 * registry in isolation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { registerSandboxRoot, unregisterSandboxRoot } from "./sandbox";
import path from "node:path";

// Reset the globalThis registry between tests so tests are independent.
function clearRegistry(): void {
  globalThis.__pi_sandbox_allowed_roots__ = [];
}

beforeEach(() => {
  clearRegistry();
});

// ---------------------------------------------------------------------------
// registerSandboxRoot
// ---------------------------------------------------------------------------

describe("registerSandboxRoot", () => {
  it("adds a resolved absolute path to the registry", () => {
    registerSandboxRoot("/tmp/my-sandbox");
    expect(globalThis.__pi_sandbox_allowed_roots__).toContain(path.resolve("/tmp/my-sandbox"));
  });

  it("resolves relative paths to absolute", () => {
    registerSandboxRoot("relative/path");
    const resolved = path.resolve("relative/path");
    expect(globalThis.__pi_sandbox_allowed_roots__).toContain(resolved);
  });

  it("does not add duplicates", () => {
    registerSandboxRoot("/tmp/sandbox");
    registerSandboxRoot("/tmp/sandbox");
    const count = globalThis.__pi_sandbox_allowed_roots__!.filter(
      (r) => r === path.resolve("/tmp/sandbox"),
    ).length;
    expect(count).toBe(1);
  });

  it("can register multiple distinct roots", () => {
    registerSandboxRoot("/tmp/root-a");
    registerSandboxRoot("/tmp/root-b");
    expect(globalThis.__pi_sandbox_allowed_roots__).toContain(path.resolve("/tmp/root-a"));
    expect(globalThis.__pi_sandbox_allowed_roots__).toContain(path.resolve("/tmp/root-b"));
    expect(globalThis.__pi_sandbox_allowed_roots__!.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// unregisterSandboxRoot
// ---------------------------------------------------------------------------

describe("unregisterSandboxRoot", () => {
  it("removes a previously-registered root", () => {
    registerSandboxRoot("/tmp/my-sandbox");
    unregisterSandboxRoot("/tmp/my-sandbox");
    expect(globalThis.__pi_sandbox_allowed_roots__).not.toContain(path.resolve("/tmp/my-sandbox"));
  });

  it("is a no-op when the path is not registered", () => {
    // Should not throw
    expect(() => unregisterSandboxRoot("/tmp/nonexistent")).not.toThrow();
    expect(globalThis.__pi_sandbox_allowed_roots__!.length).toBe(0);
  });

  it("only removes the target root, leaving others intact", () => {
    registerSandboxRoot("/tmp/root-a");
    registerSandboxRoot("/tmp/root-b");
    unregisterSandboxRoot("/tmp/root-a");
    expect(globalThis.__pi_sandbox_allowed_roots__).not.toContain(path.resolve("/tmp/root-a"));
    expect(globalThis.__pi_sandbox_allowed_roots__).toContain(path.resolve("/tmp/root-b"));
  });

  it("resolves relative path on unregister matching the registered resolved path", () => {
    const rel = "some/relative";
    registerSandboxRoot(rel);
    unregisterSandboxRoot(rel);
    expect(globalThis.__pi_sandbox_allowed_roots__!.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-root behaviour (register + unregister round-trip)
// ---------------------------------------------------------------------------

describe("multi-root round-trip", () => {
  it("register then unregister returns to empty state", () => {
    registerSandboxRoot("/tmp/wt1");
    registerSandboxRoot("/tmp/wt2");
    unregisterSandboxRoot("/tmp/wt1");
    unregisterSandboxRoot("/tmp/wt2");
    expect(globalThis.__pi_sandbox_allowed_roots__!.length).toBe(0);
  });

  it("supports repeated register/unregister cycles", () => {
    for (let i = 0; i < 3; i++) {
      registerSandboxRoot("/tmp/cycle");
      expect(globalThis.__pi_sandbox_allowed_roots__!.length).toBe(1);
      unregisterSandboxRoot("/tmp/cycle");
      expect(globalThis.__pi_sandbox_allowed_roots__!.length).toBe(0);
    }
  });
});
