// assemble-prompt.test.ts — hermetic unit tests for the prompt assembler.
// No file I/O, no model calls. readFragment is always a stub.

import { describe, it, expect } from "vitest";
import { assemblePrompt } from "./assemble-prompt.js";

/** A readFragment that returns a canned fragment for known names and null otherwise. */
function makeFragments(map: Record<string, string>) {
  return (name: string) => map[name] ?? null;
}

describe("assemblePrompt", () => {
  it("returns only the recipe prompt when no extensions", () => {
    const result = assemblePrompt({
      extensionNames: [],
      recipePrompt: "You are helpful.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({}),
    });
    expect(result).toBe("You are helpful.");
  });

  it("prepends extension fragments before the recipe prompt", () => {
    const result = assemblePrompt({
      extensionNames: ["sandbox", "deferred-write"],
      recipePrompt: "My role.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({
        sandbox: "Sandbox rules.",
        "deferred-write": "Deferred write rules.",
      }),
    });
    expect(result).toBe("Sandbox rules.\n\nDeferred write rules.\n\nMy role.");
  });

  it("skips missing fragments (readFragment returns null)", () => {
    const result = assemblePrompt({
      extensionNames: ["ext-with-fragment", "ext-without-fragment"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({ "ext-with-fragment": "Fragment text." }),
    });
    expect(result).toBe("Fragment text.\n\nRole.");
  });

  it("skips fragments that are empty strings", () => {
    const result = assemblePrompt({
      extensionNames: ["empty-ext", "real-ext"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({ "empty-ext": "", "real-ext": "Real fragment." }),
    });
    expect(result).toBe("Real fragment.\n\nRole.");
  });

  it("appends taskText after recipe prompt when provided", () => {
    const result = assemblePrompt({
      extensionNames: [],
      recipePrompt: "Base role.",
      taskText: "Specific task context.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({}),
    });
    expect(result).toBe("Base role.\n\nSpecific task context.");
  });

  it("includes fragment, recipe prompt, and taskText in correct order", () => {
    const result = assemblePrompt({
      extensionNames: ["my-ext"],
      recipePrompt: "Role.",
      taskText: "Task.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({ "my-ext": "Ext fragment." }),
    });
    expect(result).toBe("Ext fragment.\n\nRole.\n\nTask.");
  });

  // ── deferred-confirm gating ─────────────────────────────────────────────────

  it("skips deferred-confirm fragment when no deferred-* tool extensions present", () => {
    const result = assemblePrompt({
      extensionNames: ["deferred-confirm"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({ "deferred-confirm": "Confirm fragment." }),
    });
    // deferred-confirm alone → no deferred tool → fragment skipped
    expect(result).toBe("Role.");
  });

  it("includes deferred-confirm fragment when a deferred-* tool extension is active", () => {
    const result = assemblePrompt({
      extensionNames: ["deferred-write", "deferred-confirm"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({
        "deferred-write": "Write rules.",
        "deferred-confirm": "Confirm rules.",
      }),
    });
    expect(result).toBe("Write rules.\n\nConfirm rules.\n\nRole.");
  });

  it("deferred-edit counts as a deferred-* tool extension for deferred-confirm gating", () => {
    const result = assemblePrompt({
      extensionNames: ["deferred-edit", "deferred-confirm"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({
        "deferred-edit": "Edit rules.",
        "deferred-confirm": "Confirm rules.",
      }),
    });
    expect(result).toBe("Edit rules.\n\nConfirm rules.\n\nRole.");
  });

  // ── supervisor / intercept gating ──────────────────────────────────────────

  it("skips supervisor fragment when hasSupervisoryHabitat is false", () => {
    const result = assemblePrompt({
      extensionNames: ["supervisor"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({ supervisor: "Supervisor rules." }),
    });
    expect(result).toBe("Role.");
  });

  it("includes supervisor fragment when hasSupervisoryHabitat is true", () => {
    const result = assemblePrompt({
      extensionNames: ["supervisor"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: true,
      readFragment: makeFragments({ supervisor: "Supervisor rules." }),
    });
    expect(result).toBe("Supervisor rules.\n\nRole.");
  });

  it("skips intercept fragment when hasSupervisoryHabitat is false", () => {
    const result = assemblePrompt({
      extensionNames: ["intercept"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({ intercept: "Intercept rules." }),
    });
    expect(result).toBe("Role.");
  });

  it("includes intercept fragment when hasSupervisoryHabitat is true", () => {
    const result = assemblePrompt({
      extensionNames: ["intercept"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: true,
      readFragment: makeFragments({ intercept: "Intercept rules." }),
    });
    expect(result).toBe("Intercept rules.\n\nRole.");
  });

  it("includes both supervisor and intercept when hasSupervisoryHabitat is true", () => {
    const result = assemblePrompt({
      extensionNames: ["supervisor", "intercept"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: true,
      readFragment: makeFragments({
        supervisor: "Supervisor rules.",
        intercept: "Intercept rules.",
      }),
    });
    expect(result).toBe("Supervisor rules.\n\nIntercept rules.\n\nRole.");
  });

  it("extension fragment order matches extensionNames order", () => {
    const result = assemblePrompt({
      extensionNames: ["ext-c", "ext-a", "ext-b"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({
        "ext-a": "A fragment.",
        "ext-b": "B fragment.",
        "ext-c": "C fragment.",
      }),
    });
    expect(result).toBe("C fragment.\n\nA fragment.\n\nB fragment.\n\nRole.");
  });

  it("trims whitespace from fragments returned by readFragment", () => {
    const result = assemblePrompt({
      extensionNames: ["ext"],
      recipePrompt: "Role.",
      hasSupervisoryHabitat: false,
      readFragment: (_name) => "  Fragment with spaces.  ",
    });
    expect(result).toBe("Fragment with spaces.\n\nRole.");
  });

  it("omits taskText when it is only whitespace", () => {
    const result = assemblePrompt({
      extensionNames: [],
      recipePrompt: "Role.",
      taskText: "   ",
      hasSupervisoryHabitat: false,
      readFragment: makeFragments({}),
    });
    expect(result).toBe("Role.");
  });
});
