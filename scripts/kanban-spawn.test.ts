// Regression tests for buildForemanArgv in kanban.mjs.
//
// Bug fixed: the Kanban spawned Foremen without a -p flag, so pi ran in
// interactive mode, found no TTY, and exited silently in <1 s.  The Kanban
// then re-dispatched the same issue every 5 s indefinitely.
//
// Fix (Option A from issue #03 bug-3): always append `-p <seed-task>` so pi
// runs in print mode.  The recipe's prompt:  contains the full AFK Ralph Loop
// instructions; the seed task provides the concrete issue context.
//
// These tests are hermetic: no model calls, no network, no filesystem I/O.

import { describe, it, expect } from "vitest";
import { buildForemanArgv } from "./kanban.mjs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const RELPATH = "v1-fixture/issues/01-add-function.md";
const MESH_BRANCH = "feature/v1-fixture";
const PROJECT = "/tmp/fake-project";
const BUS_ROOT = "/tmp/fake-bus";
const KANBAN_WORKTREE = "/tmp/fake-kanban-wt";

function argv() {
  return buildForemanArgv(RELPATH, MESH_BRANCH, PROJECT, BUS_ROOT, KANBAN_WORKTREE);
}

// ---------------------------------------------------------------------------
// -p flag is present (core regression)
// ---------------------------------------------------------------------------

describe("buildForemanArgv — print-mode flag", () => {
  it("includes -p in the argv so pi runs in print mode (not interactive)", () => {
    const args = argv();
    expect(args).toContain("-p");
  });

  it("places the seed-task string immediately after -p", () => {
    const args = argv();
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    const seedTask = args[pIdx + 1];
    expect(typeof seedTask).toBe("string");
    expect(seedTask.length).toBeGreaterThan(0);
  });

  it("seed task references the relPath so the Foreman knows which issue to work on", () => {
    const args = argv();
    const pIdx = args.indexOf("-p");
    const seedTask = args[pIdx + 1];
    expect(seedTask).toContain(RELPATH);
  });
});

// ---------------------------------------------------------------------------
// Core recipe / flags wired correctly
// ---------------------------------------------------------------------------

describe("buildForemanArgv — recipe and flags", () => {
  it("targets the ralph/foreman recipe", () => {
    const args = argv();
    expect(args).toContain("ralph/foreman");
  });

  it("passes --sandbox <project>", () => {
    const args = argv();
    const sandboxIdx = args.indexOf("--sandbox");
    expect(sandboxIdx).toBeGreaterThan(-1);
    expect(args[sandboxIdx + 1]).toBe(PROJECT);
  });

  it("passes --agent-bus <busRoot>", () => {
    const args = argv();
    const busIdx = args.indexOf("--agent-bus");
    expect(busIdx).toBeGreaterThan(-1);
    expect(args[busIdx + 1]).toBe(BUS_ROOT);
  });

  it("passes -- separator before pi passthrough flags", () => {
    const args = argv();
    expect(args).toContain("--");
  });

  it("passes --issue <relPath> in the pi passthrough section", () => {
    const args = argv();
    const sepIdx = args.indexOf("--");
    const passthrough = args.slice(sepIdx + 1);
    const issueIdx = passthrough.indexOf("--issue");
    expect(issueIdx).toBeGreaterThan(-1);
    expect(passthrough[issueIdx + 1]).toBe(RELPATH);
  });

  it("passes --mesh-branch <branch> in the pi passthrough section", () => {
    const args = argv();
    const sepIdx = args.indexOf("--");
    const passthrough = args.slice(sepIdx + 1);
    const branchIdx = passthrough.indexOf("--mesh-branch");
    expect(branchIdx).toBeGreaterThan(-1);
    expect(passthrough[branchIdx + 1]).toBe(MESH_BRANCH);
  });
});

// ---------------------------------------------------------------------------
// argv shape (deterministic, string[] with no undefined entries)
// ---------------------------------------------------------------------------

describe("buildForemanArgv — output shape", () => {
  it("returns an array of strings", () => {
    const args = argv();
    expect(Array.isArray(args)).toBe(true);
    for (const a of args) {
      expect(typeof a).toBe("string");
    }
  });

  it("returns the same result for the same inputs (pure function)", () => {
    expect(argv()).toEqual(argv());
  });

  it("reflects a different relPath in --issue and seed task", () => {
    const other = "v1-fixture/issues/02-other.md";
    const args = buildForemanArgv(other, MESH_BRANCH, PROJECT, BUS_ROOT, KANBAN_WORKTREE);
    const sepIdx = args.indexOf("--");
    const passthrough = args.slice(sepIdx + 1);
    const issueIdx = passthrough.indexOf("--issue");
    expect(passthrough[issueIdx + 1]).toBe(other);
    const pIdx = args.indexOf("-p");
    expect(args[pIdx + 1]).toContain(other);
  });
});
