// recipe-resolver.mjs — resolves a named agent recipe into an effective recipe
// descriptor, mirroring the logic in scripts/run-agent.mjs without touching
// process state (no process.exit, no console writes).
//
// Exports a single named function: resolveRecipe(name, fsContext) → effectiveRecipe
//
// This module is intentionally a shadow read only (Slice 2). Runtime behaviour
// of npm run agent and npm run mesh is unchanged; the runner calls this after
// computing mergedExtensions and compares for divergence.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadTemplate } from "./template-loader.mjs";
import { rejectDeprecatedPeerFields } from "./recipe-validation.mjs";

const TIER_VARS = new Set(["RABBIT_SAGE_MODEL", "LEAD_HARE_MODEL", "TASK_RABBIT_MODEL"]);
const DELEGATE_TOOLS = ["delegate"];

/**
 * Deduplicates an array preserving first-occurrence order.
 *
 * @param {string[]} arr
 * @returns {string[]}
 */
function dedupFirstOccurrence(arr) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Loads a template by name and recursively resolves its `extends:` chain.
 * Returns the accumulated extension list (template chain, in base-first order).
 *
 * @param {string} templateName
 * @param {{ templatesDir: string, extensionsDir: string }} fsContext
 * @param {Set<string>} visited - Cycle-detection guard.
 * @returns {string[]}
 */
function loadTemplateChain(templateName, fsContext, visited) {
  if (visited.has(templateName)) {
    throw new Error(
      `recipe-resolver: template cycle detected involving '${templateName}'`,
    );
  }
  visited.add(templateName);

  // loadTemplate throws its own error; re-wrap with recipe-resolver: prefix.
  let templateExtensions;
  try {
    templateExtensions = loadTemplate(templateName, fsContext);
  } catch (e) {
    throw new Error(`recipe-resolver: ${e.message}`);
  }

  // Check if the template itself has an `extends:` field — read the raw YAML.
  const templatePath = path.join(fsContext.templatesDir, `${templateName}.yaml`);
  let parsed;
  try {
    parsed = parseYaml(readFileSync(templatePath, "utf8"));
  } catch (e) {
    throw new Error(`recipe-resolver: failed to parse ${templatePath}: ${e.message}`);
  }

  if (parsed && typeof parsed.extends === "string" && parsed.extends.trim()) {
    const parentExts = loadTemplateChain(parsed.extends.trim(), fsContext, visited);
    // base-first: parent extensions come before this template's own extensions
    return dedupFirstOccurrence([...parentExts, ...templateExtensions]);
  }

  return templateExtensions;
}

/**
 * Resolves a named agent recipe into an effective recipe descriptor.
 *
 * The resolver is hermetic: it reads from the filesystem via fsContext paths
 * only, throws on any validation failure, and never writes to process state.
 *
 * @param {string} name - Recipe name (without .yaml extension).
 * @param {{
 *   agentsDir:     string,  // absolute path to pi-sandbox/agents
 *   templatesDir:  string,  // absolute path to pi-sandbox/templates
 *   extensionsDir: string,  // absolute path to pi-sandbox/.pi/extensions
 * }} fsContext
 *
 * @returns {{
 *   extensionList:      string[],  // deduped first-occurrence; template chain first
 *   tools:              string[],  // recipe.tools merged with implicit-wires
 *   promptFragments:    string[],  // single-element: [recipe.prompt.trim()]
 *   habitatSpecPartial: object,    // recipe-derived Habitat fields only (no agentName/scratchRoot/busRoot/type)
 * }}
 *
 * @throws {Error} On any validation failure, prefixed with "recipe-resolver: ".
 *
 * Notes:
 * - `promptFragments` contains only the recipe body. The runner still owns
 *   extension .prompt.md concatenation (it knows hasSupervisoryHabitat); the
 *   resolver returning just the recipe body keeps this module hermetic.
 * - `habitatSpecPartial` contains only the recipe-derived Habitat fields the
 *   runner builds before the topology overlay: skills, agents (= wired.allowed),
 *   noEditAdd, noEditSkip, description (when set), and tier (when model is a
 *   TIER_VAR). It does NOT include agentName, scratchRoot, busRoot, or type —
 *   those are runner/topology concerns.
 */
export function resolveRecipe(name, fsContext) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("recipe-resolver: name must be a non-empty string");
  }

  const { agentsDir, templatesDir, extensionsDir } = fsContext ?? {};

  if (typeof agentsDir !== "string") {
    throw new Error("recipe-resolver: fsContext.agentsDir must be a string");
  }
  if (typeof templatesDir !== "string") {
    throw new Error("recipe-resolver: fsContext.templatesDir must be a string");
  }
  if (typeof extensionsDir !== "string") {
    throw new Error("recipe-resolver: fsContext.extensionsDir must be a string");
  }

  // ── Step 1: Load and validate recipe ──────────────────────────────────────

  const recipePath = path.join(agentsDir, `${name}.yaml`);
  if (!existsSync(recipePath)) {
    throw new Error(`recipe-resolver: recipe not found: ${recipePath}`);
  }

  let recipe;
  try {
    recipe = parseYaml(readFileSync(recipePath, "utf8"));
  } catch (e) {
    throw new Error(`recipe-resolver: failed to parse ${recipePath}: ${e.message}`);
  }

  if (recipe === null || recipe === undefined || typeof recipe !== "object" || Array.isArray(recipe)) {
    throw new Error(`recipe-resolver: recipe ${recipePath} must be a YAML mapping at top level`);
  }

  if (typeof recipe.prompt !== "string" || !recipe.prompt.trim()) {
    throw new Error(`recipe-resolver: recipe ${recipePath} missing 'prompt'`);
  }

  if (!Array.isArray(recipe.tools)) {
    throw new Error(`recipe-resolver: recipe ${recipePath} missing 'tools' (list)`);
  }

  // Check for deprecated peer fields — use a throw adapter so errors get the
  // recipe-resolver: prefix (rejectDeprecatedPeerFields uses the die() pattern).
  rejectDeprecatedPeerFields(recipe, name, (msg) => {
    throw new Error(`recipe-resolver: ${msg}`);
  });

  // ── Step 2: extends: resolution ───────────────────────────────────────────

  let templateExtensions = [];
  if (typeof recipe.extends === "string" && recipe.extends.trim()) {
    templateExtensions = loadTemplateChain(
      recipe.extends.trim(),
      { templatesDir, extensionsDir },
      new Set(),
    );
  }

  // ── Step 3: Validate recipe extensions ────────────────────────────────────

  const recipeExtensions = Array.isArray(recipe.extensions) ? recipe.extensions.slice() : [];
  for (let i = 0; i < recipeExtensions.length; i++) {
    const entry = recipeExtensions[i];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        `recipe-resolver: recipe '${name}' extensions[${i}] must be a non-empty string`,
      );
    }
    const extPath = path.join(extensionsDir, `${entry}.ts`);
    if (!existsSync(extPath)) {
      throw new Error(
        `recipe-resolver: extension '${entry}' listed in recipe '${name}' not found at ${extPath}`,
      );
    }
  }

  // ── Step 4: Implicit-wires (mirror applyAgentsField in run-agent.mjs) ─────

  const declaredAgents = Array.isArray(recipe.agents)
    ? recipe.agents.filter((a) => typeof a === "string")
    : [];
  const recipeTools = Array.isArray(recipe.tools) ? recipe.tools.slice() : [];

  if (declaredAgents.length === 0) {
    // Inverse rejection: atomic-delegate in extensions without agents:
    if (recipeExtensions.includes("atomic-delegate")) {
      throw new Error(
        `recipe-resolver: recipe ${name} loads extension 'atomic-delegate' but has no 'agents:' list — ` +
          `declare which child recipes are allowed (or drop the extension)`,
      );
    }
    // Inverse rejection: delegate tool in tools without agents:
    for (const t of DELEGATE_TOOLS) {
      if (recipeTools.includes(t)) {
        throw new Error(
          `recipe-resolver: recipe ${name} declares tool '${t}' but has no 'agents:' list — ` +
            `declare which child recipes are allowed (or drop the tool)`,
        );
      }
    }
  } else {
    // Validate each declared child recipe exists
    for (const a of declaredAgents) {
      const childPath = path.join(agentsDir, `${a}.yaml`);
      if (!existsSync(childPath)) {
        throw new Error(
          `recipe-resolver: recipe ${name} agents: lists '${a}', but ${childPath} does not exist`,
        );
      }
    }
  }

  // Compute implicit extensions and tools from agents:
  const implicitExtensions = declaredAgents.length > 0 ? ["atomic-delegate"] : [];
  const implicitTools = declaredAgents.length > 0 ? DELEGATE_TOOLS : [];

  // ── Step 5: Merge extensions ───────────────────────────────────────────────

  const extensionList = dedupFirstOccurrence([
    ...templateExtensions,
    ...recipeExtensions,
    ...implicitExtensions,
  ]);

  // ── Step 6: Merge tools ────────────────────────────────────────────────────

  const tools = dedupFirstOccurrence([...recipeTools, ...implicitTools]);

  // ── Step 7: Build habitatSpecPartial ──────────────────────────────────────

  const recipeModel = recipe.model || undefined;
  const habitatSpecPartial = {
    skills: Array.isArray(recipe.skills)
      ? recipe.skills.filter((s) => typeof s === "string").slice()
      : [],
    agents: declaredAgents.slice(),
    noEditAdd: Array.isArray(recipe.noEditAdd)
      ? recipe.noEditAdd.filter((s) => typeof s === "string").slice()
      : [],
    noEditSkip: Array.isArray(recipe.noEditSkip)
      ? recipe.noEditSkip.filter((s) => typeof s === "string").slice()
      : [],
    ...(typeof recipe.description === "string" && recipe.description.trim()
      ? { description: recipe.description.trim() }
      : {}),
    ...(recipeModel && TIER_VARS.has(recipeModel) ? { tier: recipeModel } : {}),
  };

  // ── Step 8: Build promptFragments ─────────────────────────────────────────

  const promptFragments = [recipe.prompt.trim()];

  // ── Return (defensive copies already applied above) ───────────────────────

  return {
    extensionList,
    tools,
    promptFragments,
    habitatSpecPartial,
  };
}
