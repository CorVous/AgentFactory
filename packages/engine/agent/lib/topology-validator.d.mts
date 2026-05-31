/**
 * topology-validator.d.mts — TypeScript declarations for topology-validator.mjs
 */

import type { Topology } from "./topology.mjs";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Optional callback to load a recipe file's `model:` field.
 * Returns the model tier string (e.g. "TASK_RABBIT_MODEL") or undefined if
 * the recipe is not found / has no model field.
 */
export type RecipeModelLoader = (recipeName: string) => string | undefined;

/**
 * Validate a topology and return { errors, warnings }.
 * Does not throw — all issues are returned in the result object.
 */
export function validateTopology(
  topo: Topology,
  recipeModelLoader?: RecipeModelLoader,
): ValidationResult;
