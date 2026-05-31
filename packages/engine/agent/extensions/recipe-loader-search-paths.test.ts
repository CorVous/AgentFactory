/**
 * recipe-loader-search-paths.test.ts — behavioural tests for the repo-local
 * search path expansion introduced in issue #170.
 *
 * Imports the promoted named exports (getRecipeDirs, getTemplateDirs) and
 * passes them to resolveRecipe to verify the engine discovers recipes in
 * pi-sandbox/agents/ from both repo-root and pi-sandbox/ invocation forms.
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getRecipeDirs, getTemplateDirs } from "./recipe-loader.js";
import { resolveRecipe } from "../lib/resolve-recipe.js";

// Resolve repo root from this file's location so the tests run on any host
// (local /home/user/AgentFactory, CI runner, contributor laptop). Walk up four
// levels: extensions/ → agent/ → engine/ → packages/ → <repo>.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

describe("recipe-loader search paths — repo-root invocation (issue #170)", () => {
  it("getRecipeDirs(repoRoot) discovers writer-foreman via pi-sandbox/agents/", () => {
    const recipeDirs = getRecipeDirs(REPO_ROOT);
    const templateDirs = getTemplateDirs(REPO_ROOT);
    // Must not throw; writer-foreman lives in pi-sandbox/agents/
    let result: ReturnType<typeof resolveRecipe>;
    expect(() => {
      result = resolveRecipe("writer-foreman", { recipeDirs, templateDirs });
    }).not.toThrow();
    expect(result!.prompt).toBeTruthy();
  });

  it("getRecipeDirs(pi-sandbox/) discovers writer-foreman via agents/", () => {
    const piSandboxDir = `${REPO_ROOT}/pi-sandbox`;
    const recipeDirs = getRecipeDirs(piSandboxDir);
    const templateDirs = getTemplateDirs(piSandboxDir);
    // pi-sandbox/agents/ is <piSandboxDir>/agents — should be in the dirs list
    let result: ReturnType<typeof resolveRecipe>;
    expect(() => {
      result = resolveRecipe("writer-foreman", { recipeDirs, templateDirs });
    }).not.toThrow();
    expect(result!.prompt).toBeTruthy();
  });
});
