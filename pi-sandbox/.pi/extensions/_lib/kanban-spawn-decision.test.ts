// Tests for the Kanban spawn-decision pure function.
// All tests are hermetic — no FS, no model, no network.

import { describe, it, expect } from "vitest";
import { decideSpawns, IssueState, ForemanRef } from "./kanban-spawn-decision";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function issue(
  path: string,
  status: string,
  claimedBy?: string,
  dependsOn?: string[],
): IssueState {
  return { path, status, claimedBy, dependsOn };
}

function foreman(issuePath: string): ForemanRef {
  return { issuePath };
}

// ---------------------------------------------------------------------------
// Empty tree
// ---------------------------------------------------------------------------

describe("decideSpawns — empty tree", () => {
  it("returns [] when there are no issues", () => {
    expect(decideSpawns([], [], 2)).toEqual([]);
  });

  it("returns [] when the tree has no workable issues (all needs-triage)", () => {
    const tree = [
      issue("a/01-foo.md", "needs-triage"),
      issue("a/02-bar.md", "needs-info"),
    ];
    expect(decideSpawns(tree, [], 2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Basic selection
// ---------------------------------------------------------------------------

describe("decideSpawns — basic selection", () => {
  it("selects a ready-for-agent issue as auto-merge", () => {
    const tree = [issue("a/01-foo.md", "ready-for-agent")];
    const result = decideSpawns(tree, [], 2);
    expect(result).toHaveLength(1);
    expect(result[0].issuePath).toBe("a/01-foo.md");
    expect(result[0].mode).toBe("auto-merge");
  });

  it("selects a ready-for-human issue as branch-emit", () => {
    const tree = [issue("a/01-foo.md", "ready-for-human")];
    const result = decideSpawns(tree, [], 2);
    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe("branch-emit");
  });

  it("selects multiple ready issues up to the concurrency cap", () => {
    const tree = [
      issue("a/01-foo.md", "ready-for-agent"),
      issue("a/02-bar.md", "ready-for-agent"),
      issue("a/03-baz.md", "ready-for-agent"),
    ];
    const result = decideSpawns(tree, [], 2);
    expect(result).toHaveLength(2);
  });

  it("selects nothing when maxConcurrent is 0", () => {
    const tree = [issue("a/01-foo.md", "ready-for-agent")];
    expect(decideSpawns(tree, [], 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Claimed issues are skipped
// ---------------------------------------------------------------------------

describe("decideSpawns — claimed issues skipped", () => {
  it("skips an issue that already has a Claimed-by line", () => {
    const tree = [issue("a/01-foo.md", "ready-for-agent", "some-foreman")];
    expect(decideSpawns(tree, [], 2)).toEqual([]);
  });

  it("does not skip an issue whose claimedBy is undefined", () => {
    const tree = [issue("a/01-foo.md", "ready-for-agent", undefined)];
    expect(decideSpawns(tree, [], 2)).toHaveLength(1);
  });

  it("selects unclaimed issues while skipping claimed ones", () => {
    const tree = [
      issue("a/01-foo.md", "ready-for-agent", "taken"),
      issue("a/02-bar.md", "ready-for-agent"),
    ];
    const result = decideSpawns(tree, [], 2);
    expect(result).toHaveLength(1);
    expect(result[0].issuePath).toBe("a/02-bar.md");
  });
});

// ---------------------------------------------------------------------------
// Already-running issues are skipped
// ---------------------------------------------------------------------------

describe("decideSpawns — already-running issues skipped", () => {
  it("skips an issue that is already in currentForemen", () => {
    const tree = [issue("a/01-foo.md", "ready-for-agent")];
    const running = [foreman("a/01-foo.md")];
    expect(decideSpawns(tree, running, 2)).toEqual([]);
  });

  it("does not skip a different issue when one is already running", () => {
    const tree = [
      issue("a/01-foo.md", "ready-for-agent"),
      issue("a/02-bar.md", "ready-for-agent"),
    ];
    const running = [foreman("a/01-foo.md")];
    const result = decideSpawns(tree, running, 3);
    expect(result).toHaveLength(1);
    expect(result[0].issuePath).toBe("a/02-bar.md");
  });
});

// ---------------------------------------------------------------------------
// Concurrency cap binds
// ---------------------------------------------------------------------------

describe("decideSpawns — concurrency cap", () => {
  it("respects the cap: only spawns up to (maxConcurrent - currentForemen.length) new ones", () => {
    const tree = [
      issue("a/01-foo.md", "ready-for-agent"),
      issue("a/02-bar.md", "ready-for-agent"),
      issue("a/03-baz.md", "ready-for-agent"),
    ];
    const running = [foreman("a/00-other.md")]; // 1 already running
    const result = decideSpawns(tree, running, 2); // cap=2, 1 running → max 1 new
    expect(result).toHaveLength(1);
  });

  it("returns [] when currentForemen already fills the cap", () => {
    const tree = [issue("a/01-foo.md", "ready-for-agent")];
    const running = [foreman("a/00-other.md"), foreman("a/00-another.md")];
    expect(decideSpawns(tree, running, 2)).toEqual([]);
  });

  it("returns [] when currentForemen exceeds the cap", () => {
    const tree = [issue("a/01-foo.md", "ready-for-agent")];
    const running = [foreman("a/00-other.md"), foreman("a/00-another.md"), foreman("a/00-third.md")];
    expect(decideSpawns(tree, running, 2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dependsOn input shape accepted (but not yet enforced in V1)
// ---------------------------------------------------------------------------

describe("decideSpawns — dependsOn field accepted on input shape", () => {
  it("accepts issues with dependsOn field without throwing", () => {
    const tree = [
      issue("a/02-bar.md", "ready-for-agent", undefined, ["a/01-blocker.md"]),
    ];
    // V1: dependsOn is NOT enforced — the issue is still selected.
    // #07 will add the blocking logic.
    expect(() => decideSpawns(tree, [], 2)).not.toThrow();
  });

  it("V1: still selects an issue that has dependsOn (blocking not wired yet)", () => {
    const tree = [
      issue("a/02-bar.md", "ready-for-agent", undefined, ["a/01-blocker.md"]),
    ];
    const result = decideSpawns(tree, [], 2);
    expect(result).toHaveLength(1);
    expect(result[0].issuePath).toBe("a/02-bar.md");
  });
});
