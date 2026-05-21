// recipe-loader.ts — engine pi extension that implements `pi --recipe <name>`.
//
// Registers the --recipe flag. On session_start, if --recipe is set:
//   1. Resolves the recipe YAML from the bundled recipes directory or cwd.
//   2. Resolves the model (tier var or literal ID).
//   3. Builds a Habitat and calls setHabitat.
//   4. Calls pi.setModel and pi.setActiveTools.
//
// If --recipe is NOT set, this extension is inert: it returns immediately,
// leaving pi in its default configuration (loaded-but-inert guarantee per ADR-0010).

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildHabitat } from "../lib/build-habitat.js";
import { resolveRecipe } from "../lib/resolve-recipe.js";
import { resolveModel } from "../lib/resolve-model.js";
import { setHabitat } from "../lib/habitat-glue.js";

// Bundled recipes directory — ships with the package.
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLED_RECIPES_DIR = path.join(PACKAGE_DIR, "agent", "recipes");

/**
 * Find a model in the registry by a `provider/model-id` string.
 * Returns undefined if not found.
 */
function findModelByString(
  ctx: ExtensionContext,
  modelString: string,
): Model<Api> | undefined {
  // Split on first '/' to get provider and model id.
  const slashIdx = modelString.indexOf("/");
  if (slashIdx === -1) {
    // No slash — try to find any model whose id matches.
    return ctx.modelRegistry.getAll().find((m) => m.id === modelString);
  }
  const provider = modelString.slice(0, slashIdx);
  const modelId = modelString.slice(slashIdx + 1);
  return ctx.modelRegistry.find(provider, modelId);
}

export default function recipeLoader(pi: ExtensionAPI) {
  pi.registerFlag("recipe", {
    description: "Name of the recipe to load from bundled recipes or <cwd>/.pi/recipes/",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    const recipeName = (pi.getFlag("recipe") as string | undefined)?.trim();

    // Loaded-but-inert: no --recipe flag → do nothing.
    if (!recipeName) return;

    // ── Resolve the recipe ────────────────────────────────────────────────────

    // Resolution order: <cwd>/.pi/recipes/ → bundled-in-package.
    let recipe;
    let recipesDir: string;

    const localRecipesDir = path.join(ctx.cwd, ".pi", "recipes");
    try {
      recipe = resolveRecipe(recipeName, { recipesDir: localRecipesDir });
      recipesDir = localRecipesDir;
    } catch {
      try {
        recipe = resolveRecipe(recipeName, { recipesDir: BUNDLED_RECIPES_DIR });
        recipesDir = BUNDLED_RECIPES_DIR;
      } catch (e) {
        ctx.ui.notify(
          `recipe-loader: recipe '${recipeName}' not found in ${localRecipesDir} or ${BUNDLED_RECIPES_DIR}: ${(e as Error).message}`,
          "error",
        );
        return;
      }
    }

    void recipesDir; // used for future extends: resolution

    // ── Resolve the model ─────────────────────────────────────────────────────

    let concreteModelId: string;
    try {
      concreteModelId = resolveModel(recipe.model, process.env as Record<string, string | undefined>);
    } catch (e) {
      ctx.ui.notify(`recipe-loader: ${(e as Error).message}`, "error");
      return;
    }

    // ── Build and set Habitat ─────────────────────────────────────────────────

    const habitat = buildHabitat({
      agentName: ctx.sessionId ?? recipeName,
      cwd: ctx.cwd,
      flags: {},
      recipe,
    });

    try {
      setHabitat(habitat);
    } catch (e) {
      ctx.ui.notify(`recipe-loader: setHabitat failed: ${(e as Error).message}`, "error");
      return;
    }

    // ── Apply model ───────────────────────────────────────────────────────────

    const model = findModelByString(ctx, concreteModelId);
    if (model) {
      const success = await pi.setModel(model);
      if (!success) {
        ctx.ui.notify(
          `recipe-loader: no API key available for model '${concreteModelId}' — model not applied`,
          "warning",
        );
      }
    } else {
      ctx.ui.notify(
        `recipe-loader: model '${concreteModelId}' not found in registry — model not applied`,
        "warning",
      );
    }

    // ── Apply tool allowlist ──────────────────────────────────────────────────

    if (recipe.tools.length > 0) {
      const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
      const validTools = recipe.tools.filter((t) => allToolNames.has(t));
      const invalidTools = recipe.tools.filter((t) => !allToolNames.has(t));

      if (invalidTools.length > 0) {
        ctx.ui.notify(
          `recipe-loader: tools not available: [${invalidTools.join(", ")}]`,
          "warning",
        );
      }

      if (validTools.length > 0) {
        pi.setActiveTools(validTools);
      }
    }
  });

  // Inject the recipe's system prompt for every agent turn when a recipe is active.
  pi.on("before_agent_start", async (event, ctx) => {
    const recipeName = (pi.getFlag("recipe") as string | undefined)?.trim();
    if (!recipeName) return undefined;

    // Re-resolve the recipe each time to keep this handler pure.
    // This is fast (disk read) and avoids module-level state.
    let recipe;
    const localRecipesDir = path.join(ctx.cwd, ".pi", "recipes");
    try {
      recipe = resolveRecipe(recipeName, { recipesDir: localRecipesDir });
    } catch {
      try {
        recipe = resolveRecipe(recipeName, { recipesDir: BUNDLED_RECIPES_DIR });
      } catch {
        return undefined;
      }
    }

    if (!recipe.prompt) return undefined;

    // Replace the system prompt with the recipe's prompt.
    return {
      systemPrompt: recipe.prompt,
    };
  });
}
