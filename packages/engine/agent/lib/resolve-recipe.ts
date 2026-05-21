// resolve-recipe.ts — minimal recipe resolver for the engine package.
//
// Resolves a named recipe from the bundled recipes directory (or a custom
// recipesDir), parses the YAML, validates required fields, and returns
// a normalised recipe descriptor.
//
// Pure: no I/O beyond reading the recipe file. Throws on any validation
// failure. Does not write to process state.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const TIER_VARS = new Set(["RABBIT_SAGE_MODEL", "LEAD_HARE_MODEL", "TASK_RABBIT_MODEL"]);
const DEFAULT_MODEL = "TASK_RABBIT_MODEL";

export interface ResolvedRecipe {
  /** Concrete model field (tier var name or literal ID). Defaults to TASK_RABBIT_MODEL. */
  model: string;
  /** Tool allowlist from the recipe. */
  tools: string[];
  /** Extension names declared in the recipe. */
  extensions: string[];
  /** The recipe's system prompt (trimmed). */
  prompt: string;
  /** Skill names declared in the recipe. */
  skills: string[];
  /** Allowed child agent recipe names. */
  agents: string[];
  /** Optional description for display. */
  description?: string;
}

export interface ResolveRecipeOptions {
  /** Directory to search for <name>.yaml files. */
  recipesDir: string;
}

/**
 * Resolve a named recipe by name.
 *
 * Bundled-only lookup: reads `<recipesDir>/<name>.yaml`, parses YAML,
 * validates required fields, and returns a normalised ResolvedRecipe.
 *
 * `extends:` chains are deferred to Slice 2; any `extends:` field in
 * the recipe is silently ignored here.
 *
 * @param name - Recipe name (without .yaml extension).
 * @param opts - See ResolveRecipeOptions.
 * @returns Normalised ResolvedRecipe.
 * @throws {Error} When the recipe file is missing or fields are invalid.
 */
export function resolveRecipe(name: string, opts: ResolveRecipeOptions): ResolvedRecipe {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("resolveRecipe: name must be a non-empty string");
  }

  const { recipesDir } = opts;
  if (typeof recipesDir !== "string") {
    throw new Error("resolveRecipe: opts.recipesDir must be a string");
  }

  const recipePath = path.join(recipesDir, `${name}.yaml`);
  if (!existsSync(recipePath)) {
    throw new Error(`resolveRecipe: recipe not found: ${recipePath}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(recipePath, "utf8"));
  } catch (e) {
    throw new Error(`resolveRecipe: failed to parse ${recipePath}: ${(e as Error).message}`);
  }

  if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`resolveRecipe: recipe ${recipePath} must be a YAML mapping at top level`);
  }

  const obj = parsed as Record<string, unknown>;

  // Validate prompt
  if (typeof obj.prompt !== "string" || !obj.prompt.trim()) {
    throw new Error(`resolveRecipe: recipe '${name}' missing or empty 'prompt'`);
  }

  // Validate tools
  if (!Array.isArray(obj.tools)) {
    throw new Error(`resolveRecipe: recipe '${name}' missing 'tools' (must be a list)`);
  }

  const model = typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : DEFAULT_MODEL;

  const tools = (obj.tools as unknown[])
    .filter((t): t is string => typeof t === "string")
    .slice();

  const extensions = Array.isArray(obj.extensions)
    ? (obj.extensions as unknown[]).filter((e): e is string => typeof e === "string").slice()
    : [];

  const skills = Array.isArray(obj.skills)
    ? (obj.skills as unknown[]).filter((s): s is string => typeof s === "string").slice()
    : [];

  const agents = Array.isArray(obj.agents)
    ? (obj.agents as unknown[]).filter((a): a is string => typeof a === "string").slice()
    : [];

  const description =
    typeof obj.description === "string" && obj.description.trim()
      ? obj.description.trim()
      : undefined;

  void TIER_VARS; // referenced for future tier-resolution helpers

  return {
    model,
    tools,
    extensions,
    prompt: obj.prompt.trim(),
    skills,
    agents,
    description,
  };
}
