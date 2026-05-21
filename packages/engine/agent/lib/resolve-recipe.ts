// resolve-recipe.ts — full recipe resolver for the engine package.
//
// Resolves a named recipe from a precedence-ordered list of directories
// (project → global → bundled), parses the YAML, resolves extends: chains,
// validates required fields, and returns a normalised recipe descriptor.
//
// Pure: no I/O beyond reading recipe/template files via the configured dirs.
// Throws on any validation failure. Does not write to process state.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseRef } from "./peer-spawn.js";

const TIER_VARS = new Set(["RABBIT_SAGE_MODEL", "LEAD_HARE_MODEL", "TASK_RABBIT_MODEL"]);
const DEFAULT_MODEL = "TASK_RABBIT_MODEL";

/** Per-spawn-entry wiring fields (object-form spawns: entry). */
export interface SpawnWiringEntry {
  /** Recipe name being spawned. */
  recipe: string;
  /** Wiring field values (may contain raw ref strings). */
  escalatesTo?: string;
  submitsWorkTo?: string;
  acceptsWorkFrom?: string[];
  messagesWith?: string[];
}

/** Parsed initial_mesh: entry. */
export interface InitialMeshEntry {
  recipe: string;
  name?: string;
  /** Group memberships for this spawn. Empty ⇒ joins @_default implicitly. */
  groups?: string[];
  task?: string;
  /** Any extra fields from the YAML (passed through). */
  [key: string]: unknown;
}

export interface ResolvedRecipe {
  /** Concrete model field (tier var name or literal ID). Defaults to TASK_RABBIT_MODEL. */
  model: string;
  /** Tool allowlist from the recipe. */
  tools: string[];
  /** Extension names declared in the recipe (template chain first, deduped). */
  extensions: string[];
  /** The recipe's system prompt (trimmed). */
  prompt: string;
  /** Skill names declared in the recipe. */
  skills: string[];
  /** Allowed child agent recipe names (new field name: spawns). */
  spawns: string[];
  /** Optional description for display. */
  description?: string;
  /** The template name this recipe extends (if any). */
  extends?: string;
  /** Per-recipe wiring refs from object-form spawns entries (Slice 3). */
  spawnWiring?: SpawnWiringEntry[];
  /** Parsed initial_mesh: block (Slice 3). */
  initialMesh?: InitialMeshEntry[];
}

/**
 * Options for multi-location recipe resolution (Slice 2+).
 *
 * Precedence: recipeDirs[0] wins over recipeDirs[1], etc.
 */
export interface ResolveRecipeOptions {
  /**
   * Precedence-ordered list of directories to search for <name>.yaml.
   * A bare name search checks each dir in order; first hit wins.
   *
   * Back-compat: also accepts `{ recipesDir: string }` (single-dir, Slice 1 style).
   */
  recipeDirs?: string[];
  /**
   * Precedence-ordered list of directories to search for template <name>.yaml
   * when resolving extends: chains.
   */
  templateDirs?: string[];

  // ── Back-compat (Slice 1) single-dir overload ──────────────────────────────
  /** @deprecated Use recipeDirs instead. Single-dir back-compat for Slice 1 callers. */
  recipesDir?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deduplicates an array preserving first-occurrence order.
 */
export function dedupeFirstOccurrence(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Finds a recipe file by bare name, searching dirs in order.
 * If `name` is a path ending in `.yaml` that exists, uses it directly.
 * Throws a clear error listing all searched dirs on miss.
 */
export function findRecipeFile(name: string, recipeDirs: string[]): string {
  // Explicit path (absolute or ends with .yaml) — use directly.
  if (path.extname(name) === ".yaml" || path.isAbsolute(name)) {
    if (!existsSync(name)) {
      throw new Error(`resolveRecipe: recipe file not found: ${name}`);
    }
    return name;
  }

  // Bare name — search dirs in precedence order.
  for (const dir of recipeDirs) {
    const candidate = path.join(dir, `${name}.yaml`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const searched = recipeDirs.map((d) => path.join(d, `${name}.yaml`)).join(", ");
  throw new Error(`resolveRecipe: recipe '${name}' not found; searched: ${searched}`);
}

/**
 * Loads and parses a template YAML file, returning its extensions list.
 * Searches templateDirs in order; throws on miss.
 */
function loadTemplateExtensions(templateName: string, templateDirs: string[]): string[] {
  for (const dir of templateDirs) {
    const templatePath = path.join(dir, `${templateName}.yaml`);
    if (!existsSync(templatePath)) continue;

    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(templatePath, "utf8"));
    } catch (e) {
      throw new Error(
        `resolveRecipe: failed to parse template ${templatePath}: ${(e as Error).message}`,
      );
    }

    if (
      parsed === null ||
      parsed === undefined ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `resolveRecipe: template ${templatePath} must be a YAML mapping at top level`,
      );
    }

    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.extensions)) {
      throw new Error(`resolveRecipe: template ${templatePath} missing 'extensions' list`);
    }

    return (obj.extensions as unknown[]).filter((e): e is string => typeof e === "string").slice();
  }

  const searched = templateDirs.map((d) => path.join(d, `${templateName}.yaml`)).join(", ");
  throw new Error(`resolveRecipe: template '${templateName}' not found; searched: ${searched}`);
}

/**
 * Resolves an extends: chain recursively. Returns extensions in base-first order,
 * deduped. Cycle detection is performed via the `visited` set.
 */
export function resolveExtendsChain(
  templateName: string,
  templateDirs: string[],
  visited: Set<string>,
): string[] {
  if (visited.has(templateName)) {
    throw new Error(
      `resolveRecipe: template cycle detected involving '${templateName}'`,
    );
  }
  visited.add(templateName);

  // Read the template YAML to check for its own extends: field.
  let templatePath: string | undefined;
  for (const dir of templateDirs) {
    const candidate = path.join(dir, `${templateName}.yaml`);
    if (existsSync(candidate)) {
      templatePath = candidate;
      break;
    }
  }

  if (!templatePath) {
    const searched = templateDirs.map((d) => path.join(d, `${templateName}.yaml`)).join(", ");
    throw new Error(`resolveRecipe: template '${templateName}' not found; searched: ${searched}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(templatePath, "utf8"));
  } catch (e) {
    throw new Error(
      `resolveRecipe: failed to parse template ${templatePath}: ${(e as Error).message}`,
    );
  }

  if (
    parsed === null ||
    parsed === undefined ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `resolveRecipe: template ${templatePath} must be a YAML mapping at top level`,
    );
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.extensions)) {
    throw new Error(`resolveRecipe: template ${templatePath} missing 'extensions' list`);
  }

  const ownExtensions = (obj.extensions as unknown[])
    .filter((e): e is string => typeof e === "string")
    .slice();

  // If this template also extends a parent, recurse.
  if (typeof obj.extends === "string" && obj.extends.trim()) {
    const parentExts = resolveExtendsChain(obj.extends.trim(), templateDirs, visited);
    // base-first: parent extensions come before this template's own extensions
    return dedupeFirstOccurrence([...parentExts, ...ownExtensions]);
  }

  return ownExtensions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a named recipe with multi-location search and extends: chain support.
 *
 * Resolution order for bare names: recipeDirs[0] → recipeDirs[1] → … (first hit wins).
 * Explicit .yaml paths are accepted as-is.
 *
 * `extends:` chains are resolved by searching templateDirs in the same precedence order.
 *
 * Back-compat: `{ recipesDir: string }` (Slice 1 style) is still accepted and
 * behaves as a single-element recipeDirs.
 *
 * @param name - Recipe name (bare) or explicit path ending in .yaml.
 * @param opts - See ResolveRecipeOptions.
 * @returns Normalised ResolvedRecipe.
 * @throws {Error} When the recipe file is missing or fields are invalid.
 */
export function resolveRecipe(name: string, opts: ResolveRecipeOptions): ResolvedRecipe {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("resolveRecipe: name must be a non-empty string");
  }

  // Normalise options — support back-compat { recipesDir } single-dir form.
  let recipeDirs: string[];
  let templateDirs: string[];

  if (opts.recipesDir !== undefined) {
    // Back-compat single-dir form.
    if (typeof opts.recipesDir !== "string") {
      throw new Error("resolveRecipe: opts.recipesDir must be a string");
    }
    recipeDirs = [opts.recipesDir];
    templateDirs = opts.templateDirs ?? [];
  } else if (opts.recipeDirs !== undefined) {
    if (!Array.isArray(opts.recipeDirs)) {
      throw new Error("resolveRecipe: opts.recipeDirs must be an array");
    }
    recipeDirs = opts.recipeDirs;
    templateDirs = opts.templateDirs ?? [];
  } else {
    throw new Error("resolveRecipe: opts must supply recipeDirs or recipesDir");
  }

  // ── Step 1: Find and parse recipe file ─────────────────────────────────────

  const recipePath = findRecipeFile(name, recipeDirs);

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

  // Reject retired field names with a hard parse error naming the replacement.
  const RETIRED_RECIPE_FIELDS: Record<string, string> = {
    agents: "spawns",
    acceptedFrom: "acceptsWorkFrom",
    peers: "messagesWith",
    submitTo: "submitsWorkTo",
  };
  for (const [oldName, newName] of Object.entries(RETIRED_RECIPE_FIELDS)) {
    if (oldName in obj) {
      throw new Error(
        `resolveRecipe: recipe '${name}' uses retired field '${oldName}' — renamed to '${newName}'`,
      );
    }
  }

  // Validate prompt
  if (typeof obj.prompt !== "string" || !obj.prompt.trim()) {
    throw new Error(`resolveRecipe: recipe '${name}' missing or empty 'prompt'`);
  }

  // Validate tools
  if (!Array.isArray(obj.tools)) {
    throw new Error(`resolveRecipe: recipe '${name}' missing 'tools' (must be a list)`);
  }

  const model =
    typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : DEFAULT_MODEL;

  const tools = (obj.tools as unknown[])
    .filter((t): t is string => typeof t === "string")
    .slice();

  const recipeExtensions = Array.isArray(obj.extensions)
    ? (obj.extensions as unknown[]).filter((e): e is string => typeof e === "string").slice()
    : [];

  const skills = Array.isArray(obj.skills)
    ? (obj.skills as unknown[]).filter((s): s is string => typeof s === "string").slice()
    : [];

  // ── spawns: parse both string entries and object-form entries.
  //    Object form accepts wiring fields: escalatesTo, submitsWorkTo,
  //    acceptsWorkFrom, messagesWith. Each ref value is validated via parseRef.
  const rawSpawns: unknown[] = Array.isArray(obj.spawns) ? (obj.spawns as unknown[]) : [];
  const spawns: string[] = [];
  const spawnWiring: SpawnWiringEntry[] = [];

  /** Singular fields that must NOT be given a list value. */
  const SINGULAR_WIRING_FIELDS = new Set(["escalatesTo", "submitsWorkTo"]);
  /** List fields. */
  const LIST_WIRING_FIELDS = new Set(["acceptsWorkFrom", "messagesWith"]);

  for (const entry of rawSpawns) {
    if (typeof entry === "string") {
      spawns.push(entry);
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      const rec = e.recipe;
      if (typeof rec !== "string" || !rec.trim()) {
        throw new Error(
          `resolveRecipe: recipe '${name}' has a spawns entry that is an object ` +
          `but is missing a 'recipe' string key: ${JSON.stringify(entry)}`,
        );
      }
      const recipeName = rec.trim();
      spawns.push(recipeName);

      const wiring: SpawnWiringEntry = { recipe: recipeName };

      // Parse and validate wiring fields
      for (const field of [...SINGULAR_WIRING_FIELDS, ...LIST_WIRING_FIELDS]) {
        if (!(field in e)) continue;
        const val = e[field];
        // Reject list value for singular fields
        if (SINGULAR_WIRING_FIELDS.has(field) && Array.isArray(val)) {
          throw new Error(
            `resolveRecipe: recipe '${name}' spawns entry for '${recipeName}': ` +
            `'${field}' is a singular field and must not be given a list value.`,
          );
        }
        if (LIST_WIRING_FIELDS.has(field) && !Array.isArray(val)) {
          if (val !== undefined) {
            throw new Error(
              `resolveRecipe: recipe '${name}' spawns entry for '${recipeName}': ` +
              `'${field}' must be a list.`,
            );
          }
          continue;
        }

        if (LIST_WIRING_FIELDS.has(field)) {
          const refs = (val as unknown[]).filter((r): r is string => typeof r === "string");
          // Validate each ref
          for (const ref of refs) {
            try {
              parseRef(ref);
            } catch (refErr) {
              throw new Error(
                `resolveRecipe: recipe '${name}' spawns entry for '${recipeName}': ` +
                `malformed ref in '${field}': ${(refErr as Error).message}`,
              );
            }
          }
          (wiring as unknown as Record<string, unknown>)[field] = refs;
        } else {
          // Singular field
          if (typeof val !== "string") continue;
          try {
            parseRef(val as string);
          } catch (refErr) {
            throw new Error(
              `resolveRecipe: recipe '${name}' spawns entry for '${recipeName}': ` +
              `malformed ref in '${field}': ${(refErr as Error).message}`,
            );
          }
          // Validate: recipe refs must be reachable from spawns (using the recipes collected so far + this entry)
          (wiring as unknown as Record<string, unknown>)[field] = val;
        }
      }

      spawnWiring.push(wiring);
    } else {
      throw new Error(
        `resolveRecipe: recipe '${name}' has a spawns entry that is neither a ` +
        `string nor an object with a 'recipe' key: ${JSON.stringify(entry)}`,
      );
    }
  }

  // ── Validate wiring refs: recipe names in explicit @<group>:<recipe> forms
  //    must be reachable from the recipe's spawns list.
  //    @$myGroups:<recipe> and @<recipe> are runtime filters — validated at runtime.
  for (const wiring of spawnWiring) {
    const refFields: Array<string | string[] | undefined> = [
      wiring.escalatesTo,
      wiring.submitsWorkTo,
      ...(wiring.acceptsWorkFrom ?? []),
      ...(wiring.messagesWith ?? []),
    ];
    for (const ref of refFields) {
      if (typeof ref !== "string") continue;
      if (!ref.startsWith("@")) continue;
      const body = ref.slice(1);
      // Only validate explicit @<group>:<recipe> form (not @$myGroups:<recipe>)
      if (body.startsWith("$")) continue; // symbolic refs skip validation
      const colonIdx = body.indexOf(":");
      if (colonIdx !== -1) {
        const left = body.slice(0, colonIdx);
        const right = body.slice(colonIdx + 1);
        // left is a group name (not symbolic); right is the recipe filter
        if (!left.startsWith("$") && !right.startsWith("$") && !spawns.includes(right)) {
          throw new Error(
            `resolveRecipe: recipe '${name}' spawns wiring ref '${ref}' uses ` +
            `recipe '${right}' which is not reachable from the 'spawns:' list.`,
          );
        }
      }
    }
  }

  // ── Parse initial_mesh: block ──────────────────────────────────────────────
  let initialMesh: InitialMeshEntry[] | undefined;
  if (Array.isArray(obj.initial_mesh)) {
    initialMesh = [];
    for (const item of obj.initial_mesh as unknown[]) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(
          `resolveRecipe: recipe '${name}' initial_mesh entry must be an object: ${JSON.stringify(item)}`,
        );
      }
      const e = item as Record<string, unknown>;
      if (typeof e.recipe !== "string" || !e.recipe.trim()) {
        throw new Error(
          `resolveRecipe: recipe '${name}' initial_mesh entry missing 'recipe' field: ${JSON.stringify(item)}`,
        );
      }
      // Validate groups field
      if ("groups" in e && e.groups !== undefined) {
        if (!Array.isArray(e.groups)) {
          throw new Error(
            `resolveRecipe: recipe '${name}' initial_mesh entry 'groups' must be a string array: ${JSON.stringify(item)}`,
          );
        }
        for (const g of e.groups as unknown[]) {
          if (typeof g !== "string") {
            throw new Error(
              `resolveRecipe: recipe '${name}' initial_mesh entry 'groups' contains non-string: ${JSON.stringify(g)}`,
            );
          }
          if (g.startsWith("_")) {
            throw new Error(
              `resolveRecipe: recipe '${name}' initial_mesh entry 'groups' contains reserved name '${g}' — group names starting with '_' are reserved.`,
            );
          }
        }
      }
      const meshEntry: InitialMeshEntry = { recipe: e.recipe.trim() };
      if (typeof e.name === "string" && e.name.trim()) meshEntry.name = e.name.trim();
      if (typeof e.task === "string") meshEntry.task = e.task;
      if (Array.isArray(e.groups)) meshEntry.groups = (e.groups as unknown[]).filter((g): g is string => typeof g === "string");
      // Pass through other fields
      for (const [k, v] of Object.entries(e)) {
        if (!["recipe", "name", "task", "groups"].includes(k)) {
          meshEntry[k] = v;
        }
      }
      initialMesh.push(meshEntry);
    }
  }

  const description =
    typeof obj.description === "string" && obj.description.trim()
      ? obj.description.trim()
      : undefined;

  const extendsField =
    typeof obj.extends === "string" && obj.extends.trim() ? obj.extends.trim() : undefined;

  // ── Step 2: Resolve extends: chain ────────────────────────────────────────

  let templateChainExtensions: string[] = [];
  if (extendsField && templateDirs.length > 0) {
    templateChainExtensions = resolveExtendsChain(extendsField, templateDirs, new Set());
  }

  // ── Step 3: Merge extensions (template chain first, then recipe, deduped) ──

  const extensions = dedupeFirstOccurrence([...templateChainExtensions, ...recipeExtensions]);

  void TIER_VARS; // referenced for future tier-resolution helpers

  // ── Step 4: Implicit-wire mesh-spawn ────────────────────────────────────
  // If spawns is non-empty, ensure the recipe has mesh_spawn + mesh_kill in
  // tools and mesh-spawn in extensions (add if missing).
  const finalTools = [...tools];
  const finalExtensions = [...extensions];

  if (spawns.length > 0) {
    if (!finalTools.includes("mesh_spawn")) finalTools.push("mesh_spawn");
    if (!finalTools.includes("mesh_kill")) finalTools.push("mesh_kill");
    if (!finalExtensions.includes("mesh-spawn")) finalExtensions.push("mesh-spawn");
  }

  // ── Step 5: Inverse rejection ───────────────────────────────────────────
  // mesh_spawn/mesh_kill tools or mesh-spawn extension without spawns: → error.
  const hasMeshSpawnTools =
    finalTools.includes("mesh_spawn") || finalTools.includes("mesh_kill");
  const hasMeshSpawnExt = finalExtensions.includes("mesh-spawn");
  if ((hasMeshSpawnTools || hasMeshSpawnExt) && spawns.length === 0) {
    throw new Error(
      `resolveRecipe: recipe '${name}' declares mesh_spawn/mesh_kill tools or ` +
      `mesh-spawn extension but has no 'spawns:' list. Add a 'spawns:' field with ` +
      `the allowed child recipe names.`,
    );
  }

  // Legacy inverse rejection: delegate tool or atomic-delegate extension without spawns.
  const hasDelegateTools = finalTools.includes("delegate");
  const hasAtomicDelegateExt = finalExtensions.includes("atomic-delegate");
  if ((hasDelegateTools || hasAtomicDelegateExt) && spawns.length === 0) {
    throw new Error(
      `resolveRecipe: recipe '${name}' declares 'delegate' tool or ` +
      `'atomic-delegate' extension but has no 'spawns:' list. Add a 'spawns:' field.`,
    );
  }

  const result: ResolvedRecipe = {
    model,
    tools: finalTools,
    extensions: finalExtensions,
    prompt: obj.prompt.trim(),
    skills,
    spawns,
    description,
    ...(extendsField ? { extends: extendsField } : {}),
  };

  if (spawnWiring.length > 0) result.spawnWiring = spawnWiring;
  if (initialMesh !== undefined) result.initialMesh = initialMesh;

  return result;
}
