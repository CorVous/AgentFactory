/**
 * recipe-loader-search-paths.test.ts — behavioural tests for the repo-local
 * search path expansion introduced in issue #170.
 *
 * Imports the promoted named exports (getRecipeDirs, getTemplateDirs) and
 * passes them to resolveRecipe to verify the engine discovers recipes in
 * pi-sandbox/agents/ from both repo-root and pi-sandbox/ invocation forms.
 */

import { describe, it, expect } from "vitest";
import { getRecipeDirs, getTemplateDirs } from "./recipe-loader.js";
import { resolveRecipe } from "../lib/resolve-recipe.js";

const REPO_ROOT = "/home/user/AgentFactory";

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
