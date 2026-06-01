// bundled-recipes.test.ts — static guard: the engine ships a usable `scout`
// recipe in its bundled recipes dir (BUNDLED_RECIPES_DIR = <pkg>/agent/recipes),
// so `pi --recipe scout` resolves on any install via the search-order fallback.
//
// Hermetic: reads the file and parses YAML; no pi runtime, no resolveRecipe.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// Mirror recipe-loader.ts: PACKAGE_DIR = <lib>/../.. , recipes = <pkg>/agent/recipes
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECIPES_DIR = join(PACKAGE_DIR, "agent", "recipes");
const SCOUT_RECIPE = join(RECIPES_DIR, "scout.yaml");

describe("bundled scout recipe", () => {
  it("ships in the engine's bundled recipes dir", () => {
    expect(RECIPES_DIR.endsWith(join("agent", "recipes"))).toBe(true);
    expect(existsSync(SCOUT_RECIPE)).toBe(true);
  });

  it("parses as YAML with the fields the recipe-loader needs", () => {
    const recipe = parseYaml(readFileSync(SCOUT_RECIPE, "utf8"));
    expect(recipe).toBeTruthy();
    expect(typeof recipe.model).toBe("string");
    expect(recipe.model.length).toBeGreaterThan(0);
    expect(Array.isArray(recipe.tools)).toBe(true);
    expect(recipe.tools.length).toBeGreaterThan(0);
  });

  it("is read-only (no write/edit/move/delete tools)", () => {
    const recipe = parseYaml(readFileSync(SCOUT_RECIPE, "utf8"));
    const mutating = ["write", "edit", "deferred_write", "deferred_edit", "deferred_move", "deferred_delete"];
    expect(recipe.tools.some((t: string) => mutating.includes(t))).toBe(false);
  });
});
