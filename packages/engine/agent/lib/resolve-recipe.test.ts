// resolve-recipe.test.ts — hermetic unit tests for the recipe resolver.
// No model calls, no network. Uses tmpdir for recipe files.

import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { resolveRecipe, dedupeFirstOccurrence, findRecipeFile, resolveExtendsChain } from "./resolve-recipe.js";

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

function writeTmpTemplate(name: string, content: string, subdir = "templates"): string {
  const templatesDir = path.join(tmpDir, subdir);
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(path.join(templatesDir, `${name}.yaml`), content, "utf8");
  return templatesDir;
}

function writeTmpRecipeInDir(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.yaml`), content, "utf8");
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

  it("returns spawns list from recipe", () => {
    const recipesDir = writeTmpRecipe(
      "with-spawns",
      `tools:\n  - read\nprompt: "p"\nspawns:\n  - child-agent\n`,
    );
    const result = resolveRecipe("with-spawns", { recipesDir });
    expect(result.spawns).toEqual(["child-agent"]);
  });

  it("returns empty spawns array when not set", () => {
    const recipesDir = writeTmpRecipe(
      "no-spawns",
      `tools:\n  - read\nprompt: "p"\n`,
    );
    const result = resolveRecipe("no-spawns", { recipesDir });
    expect(result.spawns).toEqual([]);
  });

  it("throws hard error when recipe uses retired field 'agents'", () => {
    const recipesDir = writeTmpRecipe(
      "retired-agents",
      `tools:\n  - read\nprompt: "p"\nagents:\n  - child-agent\n`,
    );
    expect(() => resolveRecipe("retired-agents", { recipesDir })).toThrow(
      /retired field 'agents'.*renamed to 'spawns'/,
    );
  });

  it("throws hard error when recipe uses retired field 'acceptedFrom'", () => {
    const recipesDir = writeTmpRecipe(
      "retired-acceptedFrom",
      `tools:\n  - read\nprompt: "p"\nacceptedFrom:\n  - boss\n`,
    );
    expect(() => resolveRecipe("retired-acceptedFrom", { recipesDir })).toThrow(
      /retired field 'acceptedFrom'.*renamed to 'acceptsWorkFrom'/,
    );
  });

  it("throws hard error when recipe uses retired field 'peers'", () => {
    const recipesDir = writeTmpRecipe(
      "retired-peers",
      `tools:\n  - read\nprompt: "p"\npeers:\n  - boss\n`,
    );
    expect(() => resolveRecipe("retired-peers", { recipesDir })).toThrow(
      /retired field 'peers'.*renamed to 'messagesWith'/,
    );
  });

  it("throws hard error when recipe uses retired field 'submitTo'", () => {
    const recipesDir = writeTmpRecipe(
      "retired-submitTo",
      `tools:\n  - read\nprompt: "p"\nsubmitTo: boss\n`,
    );
    expect(() => resolveRecipe("retired-submitTo", { recipesDir })).toThrow(
      /retired field 'submitTo'.*renamed to 'submitsWorkTo'/,
    );
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

// ---------------------------------------------------------------------------
// Slice 2: multi-location search + extends chain
// ---------------------------------------------------------------------------

describe("findRecipeFile — multi-dir search", () => {
  it("finds a recipe in the first (project) dir when it exists", () => {
    const projectDir = path.join(tmpDir, "project-recipes");
    const globalDir = path.join(tmpDir, "global-recipes");
    const bundledDir = path.join(tmpDir, "bundled-recipes");
    writeTmpRecipeInDir(projectDir, "my-agent", `tools:\n  - read\nprompt: "p"\n`);
    writeTmpRecipeInDir(bundledDir, "my-agent", `tools:\n  - ls\nprompt: "bundled"\n`);
    const found = findRecipeFile("my-agent", [projectDir, globalDir, bundledDir]);
    expect(found).toBe(path.join(projectDir, "my-agent.yaml"));
  });

  it("falls through to bundled dir when recipe absent from project + global", () => {
    const projectDir = path.join(tmpDir, "project-recipes-empty");
    const globalDir = path.join(tmpDir, "global-recipes-empty");
    const bundledDir = path.join(tmpDir, "bundled-only");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    writeTmpRecipeInDir(bundledDir, "bundled-agent", `tools:\n  - read\nprompt: "p"\n`);
    const found = findRecipeFile("bundled-agent", [projectDir, globalDir, bundledDir]);
    expect(found).toBe(path.join(bundledDir, "bundled-agent.yaml"));
  });

  it("project wins over global (project-wins precedence)", () => {
    const projectDir = path.join(tmpDir, "proj");
    const globalDir = path.join(tmpDir, "glob");
    writeTmpRecipeInDir(projectDir, "shared", `tools:\n  - read\nprompt: "project version"\n`);
    writeTmpRecipeInDir(globalDir, "shared", `tools:\n  - ls\nprompt: "global version"\n`);
    const found = findRecipeFile("shared", [projectDir, globalDir]);
    expect(found).toBe(path.join(projectDir, "shared.yaml"));
  });

  it("accepts an explicit .yaml path that exists", () => {
    const dir = path.join(tmpDir, "explicit");
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "myrecipe.yaml");
    writeFileSync(filePath, `tools:\n  - read\nprompt: "p"\n`, "utf8");
    const found = findRecipeFile(filePath, []);
    expect(found).toBe(filePath);
  });

  it("throws a clear error listing all searched dirs when recipe not found", () => {
    const dir1 = path.join(tmpDir, "d1");
    const dir2 = path.join(tmpDir, "d2");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    expect(() => findRecipeFile("missing-agent", [dir1, dir2])).toThrowError(
      /missing-agent.*not found.*searched/,
    );
  });

  it("not-found error names all searched dirs", () => {
    const dir1 = path.join(tmpDir, "search-a");
    const dir2 = path.join(tmpDir, "search-b");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    let errMsg = "";
    try {
      findRecipeFile("ghost", [dir1, dir2]);
    } catch (e) {
      errMsg = (e as Error).message;
    }
    expect(errMsg).toContain("search-a");
    expect(errMsg).toContain("search-b");
  });
});

describe("resolveRecipe — multi-dir recipeDirs", () => {
  it("accepts recipeDirs array and resolves from first dir", () => {
    const dir = path.join(tmpDir, "multi-recipes");
    writeTmpRecipeInDir(dir, "multi-agent", `tools:\n  - read\nprompt: "p"\n`);
    const result = resolveRecipe("multi-agent", { recipeDirs: [dir] });
    expect(result.prompt).toBe("p");
  });

  it("falls through recipeDirs to second dir when first lacks the recipe", () => {
    const dir1 = path.join(tmpDir, "rec1");
    const dir2 = path.join(tmpDir, "rec2");
    mkdirSync(dir1, { recursive: true });
    writeTmpRecipeInDir(dir2, "fallback-agent", `tools:\n  - read\nprompt: "found in dir2"\n`);
    const result = resolveRecipe("fallback-agent", { recipeDirs: [dir1, dir2] });
    expect(result.prompt).toBe("found in dir2");
  });
});

describe("resolveExtendsChain — template chain resolution", () => {
  it("resolves a single-level extends chain", () => {
    const templatesDir = writeTmpTemplate(
      "base",
      `extensions:\n  - sandbox\n  - no-startup-help\n`,
    );
    const result = resolveExtendsChain("base", [templatesDir], new Set());
    expect(result).toEqual(["sandbox", "no-startup-help"]);
  });

  it("resolves a two-level extends chain in base-first order", () => {
    const templatesDir = path.join(tmpDir, "templates-chain");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(
      path.join(templatesDir, "grandparent.yaml"),
      `extensions:\n  - sandbox\n`,
      "utf8",
    );
    writeFileSync(
      path.join(templatesDir, "parent.yaml"),
      `extends: grandparent\nextensions:\n  - no-startup-help\n`,
      "utf8",
    );
    const result = resolveExtendsChain("parent", [templatesDir], new Set());
    // base-first: grandparent's extensions come before parent's
    expect(result).toEqual(["sandbox", "no-startup-help"]);
  });

  it("deduplicates extensions across template chain", () => {
    const templatesDir = path.join(tmpDir, "templates-dedup");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(
      path.join(templatesDir, "base-dedup.yaml"),
      `extensions:\n  - sandbox\n  - agent-header\n`,
      "utf8",
    );
    writeFileSync(
      path.join(templatesDir, "child-dedup.yaml"),
      `extends: base-dedup\nextensions:\n  - sandbox\n  - deferred-write\n`,
      "utf8",
    );
    const result = resolveExtendsChain("child-dedup", [templatesDir], new Set());
    // sandbox appears in both; should appear only once (first occurrence from base)
    expect(result).toEqual(["sandbox", "agent-header", "deferred-write"]);
  });

  it("throws on a direct cycle", () => {
    const templatesDir = path.join(tmpDir, "templates-cycle");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(
      path.join(templatesDir, "cyclic.yaml"),
      `extends: cyclic\nextensions:\n  - sandbox\n`,
      "utf8",
    );
    expect(() => resolveExtendsChain("cyclic", [templatesDir], new Set())).toThrowError(
      /cycle/,
    );
  });

  it("throws on an indirect cycle", () => {
    const templatesDir = path.join(tmpDir, "templates-indirect-cycle");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(
      path.join(templatesDir, "a.yaml"),
      `extends: b\nextensions:\n  - sandbox\n`,
      "utf8",
    );
    writeFileSync(
      path.join(templatesDir, "b.yaml"),
      `extends: a\nextensions:\n  - agent-header\n`,
      "utf8",
    );
    expect(() => resolveExtendsChain("a", [templatesDir], new Set())).toThrowError(
      /cycle/,
    );
  });

  it("searches templateDirs in precedence order (project wins)", () => {
    const projectTemplatesDir = path.join(tmpDir, "proj-templates");
    const globalTemplatesDir = path.join(tmpDir, "global-templates");
    mkdirSync(projectTemplatesDir, { recursive: true });
    mkdirSync(globalTemplatesDir, { recursive: true });
    writeFileSync(
      path.join(projectTemplatesDir, "shared-tmpl.yaml"),
      `extensions:\n  - project-ext\n`,
      "utf8",
    );
    writeFileSync(
      path.join(globalTemplatesDir, "shared-tmpl.yaml"),
      `extensions:\n  - global-ext\n`,
      "utf8",
    );
    const result = resolveExtendsChain(
      "shared-tmpl",
      [projectTemplatesDir, globalTemplatesDir],
      new Set(),
    );
    expect(result).toEqual(["project-ext"]);
  });
});

describe("resolveRecipe — extends chain integration", () => {
  it("prepends template chain extensions before recipe extensions", () => {
    const templatesDir = path.join(tmpDir, "tmpl-integration");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(
      path.join(templatesDir, "my-template.yaml"),
      `extensions:\n  - sandbox\n  - agent-header\n`,
      "utf8",
    );
    const recipesDir = path.join(tmpDir, "recipes-integration");
    writeTmpRecipeInDir(
      recipesDir,
      "extended-agent",
      `extends: my-template\ntools:\n  - read\nprompt: "p"\nextensions:\n  - deferred-write\n`,
    );
    const result = resolveRecipe("extended-agent", {
      recipeDirs: [recipesDir],
      templateDirs: [templatesDir],
    });
    expect(result.extensions).toEqual(["sandbox", "agent-header", "deferred-write"]);
    expect(result.extends).toBe("my-template");
  });

  it("deduplicates extensions when template and recipe overlap", () => {
    const templatesDir = path.join(tmpDir, "tmpl-dedup-int");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(
      path.join(templatesDir, "base-tmpl.yaml"),
      `extensions:\n  - sandbox\n  - deferred-write\n`,
      "utf8",
    );
    const recipesDir = path.join(tmpDir, "recipes-dedup-int");
    writeTmpRecipeInDir(
      recipesDir,
      "dedup-agent",
      `extends: base-tmpl\ntools:\n  - read\nprompt: "p"\nextensions:\n  - deferred-write\n  - no-edit\n`,
    );
    const result = resolveRecipe("dedup-agent", {
      recipeDirs: [recipesDir],
      templateDirs: [templatesDir],
    });
    // deferred-write appears in both template and recipe; first occurrence wins
    expect(result.extensions).toEqual(["sandbox", "deferred-write", "no-edit"]);
  });
});

describe("dedupeFirstOccurrence", () => {
  it("returns empty array for empty input", () => {
    expect(dedupeFirstOccurrence([])).toEqual([]);
  });

  it("preserves first occurrence of each element", () => {
    expect(dedupeFirstOccurrence(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("returns the same array content for all-unique input", () => {
    expect(dedupeFirstOccurrence(["x", "y", "z"])).toEqual(["x", "y", "z"]);
  });
});
