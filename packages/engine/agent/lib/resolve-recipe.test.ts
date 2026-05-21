// resolve-recipe.test.ts — hermetic unit tests for the recipe resolver.
// No model calls, no network. Uses tmpdir for recipe files.

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { resolveRecipe } from "./resolve-recipe.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "resolve-recipe-test-"));
});

afterEach(() => {
  // tmpdir is cleaned up by OS eventually; no explicit cleanup needed for test isolation
});

function writeTmpRecipe(name: string, content: string): string {
  const recipesDir = path.join(tmpDir, "recipes");
  mkdirSync(recipesDir, { recursive: true });
  writeFileSync(path.join(recipesDir, `${name}.yaml`), content, "utf8");
  return recipesDir;
}

describe("resolveRecipe", () => {
  it("resolves a minimal valid recipe", () => {
    const recipesDir = writeTmpRecipe(
      "my-agent",
      `model: TASK_RABBIT_MODEL\ntools:\n  - read\nprompt: "You are helpful."\n`,
    );
    const result = resolveRecipe("my-agent", { recipesDir });
    expect(result.model).toBe("TASK_RABBIT_MODEL");
    expect(result.tools).toEqual(["read"]);
    expect(result.prompt).toBe("You are helpful.");
  });

  it("returns default model TASK_RABBIT_MODEL when model field is omitted", () => {
    const recipesDir = writeTmpRecipe(
      "no-model",
      `tools:\n  - ls\nprompt: "Hello."\n`,
    );
    const result = resolveRecipe("no-model", { recipesDir });
    expect(result.model).toBe("TASK_RABBIT_MODEL");
  });

  it("returns empty extensions array when recipe has none", () => {
    const recipesDir = writeTmpRecipe(
      "bare",
      `tools:\n  - read\nprompt: "p"\n`,
    );
    const result = resolveRecipe("bare", { recipesDir });
    expect(result.extensions).toEqual([]);
  });

  it("returns extensions when recipe declares them", () => {
    const recipesDir = writeTmpRecipe(
      "with-ext",
      `model: TASK_RABBIT_MODEL\ntools:\n  - read\nprompt: "p"\nextensions:\n  - deferred-write\n`,
    );
    const result = resolveRecipe("with-ext", { recipesDir });
    expect(result.extensions).toEqual(["deferred-write"]);
  });

  it("returns description when set in recipe", () => {
    const recipesDir = writeTmpRecipe(
      "with-desc",
      `tools:\n  - read\nprompt: "p"\ndescription: "My agent description"\n`,
    );
    const result = resolveRecipe("with-desc", { recipesDir });
    expect(result.description).toBe("My agent description");
  });

  it("returns undefined description when not set", () => {
    const recipesDir = writeTmpRecipe(
      "no-desc",
      `tools:\n  - read\nprompt: "p"\n`,
    );
    const result = resolveRecipe("no-desc", { recipesDir });
    expect(result.description).toBeUndefined();
  });

  it("returns skills list from recipe", () => {
    const recipesDir = writeTmpRecipe(
      "with-skills",
      `tools:\n  - read\nprompt: "p"\nskills:\n  - skill-a\n  - skill-b\n`,
    );
    const result = resolveRecipe("with-skills", { recipesDir });
    expect(result.skills).toEqual(["skill-a", "skill-b"]);
  });

  it("returns empty skills array when not set", () => {
    const recipesDir = writeTmpRecipe(
      "no-skills",
      `tools:\n  - read\nprompt: "p"\n`,
    );
    const result = resolveRecipe("no-skills", { recipesDir });
    expect(result.skills).toEqual([]);
  });

  it("returns agents list from recipe", () => {
    const recipesDir = writeTmpRecipe(
      "with-agents",
      `tools:\n  - read\nprompt: "p"\nagents:\n  - child-agent\n`,
    );
    const result = resolveRecipe("with-agents", { recipesDir });
    expect(result.agents).toEqual(["child-agent"]);
  });

  it("returns empty agents array when not set", () => {
    const recipesDir = writeTmpRecipe(
      "no-agents",
      `tools:\n  - read\nprompt: "p"\n`,
    );
    const result = resolveRecipe("no-agents", { recipesDir });
    expect(result.agents).toEqual([]);
  });

  it("throws when recipe file does not exist", () => {
    const recipesDir = path.join(tmpDir, "recipes");
    mkdirSync(recipesDir, { recursive: true });
    expect(() => resolveRecipe("nonexistent", { recipesDir })).toThrow(/not found/);
  });

  it("throws when recipe is missing 'prompt'", () => {
    const recipesDir = writeTmpRecipe(
      "no-prompt",
      `model: TASK_RABBIT_MODEL\ntools:\n  - read\n`,
    );
    expect(() => resolveRecipe("no-prompt", { recipesDir })).toThrow(/prompt/);
  });

  it("throws when recipe has empty string prompt", () => {
    const recipesDir = writeTmpRecipe(
      "empty-prompt",
      `model: TASK_RABBIT_MODEL\ntools:\n  - read\nprompt: ""\n`,
    );
    expect(() => resolveRecipe("empty-prompt", { recipesDir })).toThrow(/prompt/);
  });

  it("throws when recipe is missing 'tools'", () => {
    const recipesDir = writeTmpRecipe(
      "no-tools",
      `model: TASK_RABBIT_MODEL\nprompt: "You are helpful."\n`,
    );
    expect(() => resolveRecipe("no-tools", { recipesDir })).toThrow(/tools/);
  });

  it("throws when tools is not a list", () => {
    const recipesDir = writeTmpRecipe(
      "tools-not-list",
      `model: TASK_RABBIT_MODEL\ntools: read\nprompt: "p"\n`,
    );
    expect(() => resolveRecipe("tools-not-list", { recipesDir })).toThrow(/tools/);
  });

  it("trims whitespace from prompt", () => {
    const recipesDir = writeTmpRecipe(
      "whitespace-prompt",
      `tools:\n  - read\nprompt: "  hello world  "\n`,
    );
    const result = resolveRecipe("whitespace-prompt", { recipesDir });
    expect(result.prompt).toBe("hello world");
  });
});
