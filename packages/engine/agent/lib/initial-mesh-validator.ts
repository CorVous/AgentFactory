// initial-mesh-validator.ts — pure validator for initial_mesh: recipe entries.
//
// Used by mesh-mux.ts at session_start to validate the host recipe's
// initial_mesh: block before spawning any peers.
//
// Pure: no I/O. recipeExists is an injected predicate for hermetic testing.
//
// See ADR-0009 §processInitialMesh.

import { parseRef } from "./peer-spawn.js";
import type { InitialMeshEntry } from "./resolve-recipe.js";

/**
 * Validate an initial_mesh: entry list against the recipe's spawns: allowlist.
 *
 * Checks:
 *   1. Each entry's `recipe` must be in `recipeSpawns`.
 *   2. The recipe file must exist (via injected `recipeExists` predicate).
 *   3. No duplicate explicit `name:` values.
 *   4. `groups` values must be non-empty strings, none starting with `_`.
 *   5. Any `@`-ref fields in wiring overrides must parse successfully via `parseRef`.
 *
 * @param entries       The initial_mesh: array from the recipe.
 * @param recipeSpawns  The recipe's spawns: allowlist.
 * @param recipeExists  Injected predicate: (recipeName) → boolean. Keeps this hermetic.
 * @returns             { errors: string[] } — empty means valid.
 */
export function validateInitialMesh(
  entries: InitialMeshEntry[],
  recipeSpawns: string[],
  recipeExists: (recipeName: string) => boolean,
): { errors: string[] } {
  const errors: string[] = [];
  const spawnsSet = new Set(recipeSpawns);
  const seenNames = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const ctx = `initial_mesh[${i}]${entry.name ? ` (${entry.name})` : ""}`;

    // Rule 1: recipe must be in spawns: allowlist
    if (!entry.recipe || typeof entry.recipe !== "string") {
      errors.push(`${ctx}: missing required 'recipe' field`);
      continue;
    }
    if (!spawnsSet.has(entry.recipe)) {
      const list = recipeSpawns.length > 0 ? `[${recipeSpawns.join(", ")}]` : "[]";
      errors.push(
        `${ctx}: recipe '${entry.recipe}' not in spawns: allowlist ${list}`,
      );
    }

    // Rule 2: recipe file must exist
    if (!recipeExists(entry.recipe)) {
      errors.push(`${ctx}: recipe file '${entry.recipe}.yaml' not found`);
    }

    // Rule 3: no duplicate explicit names
    if (entry.name !== undefined) {
      if (typeof entry.name !== "string" || !entry.name) {
        errors.push(`${ctx}: 'name' must be a non-empty string`);
      } else if (seenNames.has(entry.name)) {
        errors.push(`${ctx}: duplicate explicit name '${entry.name}'`);
      } else {
        seenNames.add(entry.name);
      }
    }

    // Rule 4: groups must be non-empty strings, none starting with '_'
    if (entry.groups !== undefined) {
      if (!Array.isArray(entry.groups)) {
        errors.push(`${ctx}: 'groups' must be an array`);
      } else {
        for (const g of entry.groups) {
          if (typeof g !== "string" || !g) {
            errors.push(`${ctx}: 'groups' must contain non-empty strings`);
          } else if (g.startsWith("_")) {
            errors.push(
              `${ctx}: group name '${g}' is reserved — names starting with '_' are not allowed`,
            );
          }
        }
      }
    }

    // Rule 5: @-ref fields in wiring overrides must parse via parseRef
    const refFields: Array<[string, unknown]> = [
      ["escalatesTo", entry.escalatesTo],
      ["submitsWorkTo", entry.submitsWorkTo],
    ];
    const refArrayFields: Array<[string, unknown]> = [
      ["messagesWith", entry.messagesWith],
      ["acceptsWorkFrom", entry.acceptsWorkFrom],
    ];

    for (const [fieldName, value] of refFields) {
      if (value !== undefined && typeof value === "string") {
        try {
          parseRef(value);
        } catch (e) {
          errors.push(`${ctx}: invalid ref in '${fieldName}': ${(e as Error).message}`);
        }
      }
    }

    for (const [fieldName, value] of refArrayFields) {
      if (value !== undefined) {
        if (!Array.isArray(value)) {
          errors.push(`${ctx}: '${fieldName}' must be an array`);
        } else {
          for (const ref of value) {
            if (typeof ref === "string") {
              try {
                parseRef(ref);
              } catch (e) {
                errors.push(`${ctx}: invalid ref in '${fieldName}': ${(e as Error).message}`);
              }
            }
          }
        }
      }
    }
  }

  return { errors };
}
