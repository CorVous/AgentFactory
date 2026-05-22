// recipe-loader.ts — engine pi extension that implements `pi --recipe <name>`.
//
// Registers the --recipe flag. On session_start, if --recipe is set:
//   1. Resolves the recipe YAML (project → global → bundled precedence).
//   2. Resolves skills to absolute directory paths.
//   3. Resolves the model (tier var or literal ID).
//   4. Builds a Habitat and calls setHabitat.
//   5. Calls pi.setModel and pi.setActiveTools.
//
// On before_agent_start, if --recipe is set:
//   6. Assembles the full system prompt (extension fragments + recipe prompt).
//
// If --recipe is NOT set, this extension is inert: it returns immediately,
// leaving pi in its default configuration (loaded-but-inert guarantee per ADR-0010).

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildHabitat, mergeTopologyOverlay } from "../lib/build-habitat.js";
import { resolveRecipe } from "../lib/resolve-recipe.js";
import { resolveModel } from "../lib/resolve-model.js";
import { loadBundledDefaults, loadOverrideConfig } from "../lib/load-tier-config.js";
import { resolveSkills } from "../lib/resolve-skills.js";
import { assemblePrompt } from "../lib/assemble-prompt.js";
import { setHabitat } from "../lib/habitat-glue.js";
import { resolveRailPackages, RAIL_TO_CLUSTER } from "../lib/rail-packages.js";
import { discoverInstalledPackages } from "../lib/installed-packages.js";

// Bundled recipes/templates/skills directories — ship with the package.
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLED_RECIPES_DIR = path.join(PACKAGE_DIR, "agent", "recipes");
const BUNDLED_TEMPLATES_DIR = path.join(PACKAGE_DIR, "agent", "templates");
const BUNDLED_SKILLS_DIR = path.join(PACKAGE_DIR, "agent", "skills");
const BUNDLED_EXTENSIONS_DIR = path.join(PACKAGE_DIR, "agent", "extensions");

/**
 * Returns the precedence-ordered list of recipe directories:
 * project (<cwd>/.pi/recipes/) → global (~/.pi/agent/recipes/) → bundled.
 */
function getRecipeDirs(cwd: string): string[] {
  return [
    path.join(cwd, ".pi", "recipes"),
    path.join(os.homedir(), ".pi", "agent", "recipes"),
    BUNDLED_RECIPES_DIR,
  ];
}

/**
 * Returns the precedence-ordered list of template directories:
 * project (<cwd>/.pi/templates/) → global (~/.pi/agent/templates/) → bundled.
 */
function getTemplateDirs(cwd: string): string[] {
  return [
    path.join(cwd, ".pi", "templates"),
    path.join(os.homedir(), ".pi", "agent", "templates"),
    BUNDLED_TEMPLATES_DIR,
  ];
}

/**
 * Returns the precedence-ordered list of skill directories:
 * project (<cwd>/.pi/skills/) → global (~/.pi/agent/skills/) → bundled.
 */
function getSkillDirs(cwd: string): string[] {
  return [
    path.join(cwd, ".pi", "skills"),
    path.join(os.homedir(), ".pi", "agent", "skills"),
    BUNDLED_SKILLS_DIR,
  ];
}

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

/**
 * Returns the absolute path to the extensions directory for the named cluster package,
 * looked up in node_modules relative to the engine package.
 */
function clusterExtensionsDir(clusterName: string): string {
  return path.resolve(PACKAGE_DIR, "..", "..", "node_modules", "@agentfactory", clusterName, "agent", "extensions");
}

/**
 * Reads an extension fragment file for the given extension name.
 * Engine-owned fragments resolve from the bundled extensions dir.
 * Cluster-owned fragments resolve from the installed cluster package dir.
 * Returns the trimmed contents, or null if the file does not exist.
 */
function readExtensionFragment(extName: string): string | null {
  // Determine which directory to search.
  const cluster = RAIL_TO_CLUSTER[extName];
  let searchDir: string;
  if (!cluster || cluster === "engine") {
    searchDir = BUNDLED_EXTENSIONS_DIR;
  } else {
    searchDir = clusterExtensionsDir(cluster);
  }

  const fragmentPath = path.join(searchDir, `${extName}.prompt.md`);
  if (!existsSync(fragmentPath)) return null;
  try {
    return readFileSync(fragmentPath, "utf8").trim();
  } catch {
    return null;
  }
}

export default function recipeLoader(pi: ExtensionAPI) {
  pi.registerFlag("recipe", {
    description: "Name of the recipe to load from <cwd>/.pi/recipes/, ~/.pi/agent/recipes/, or bundled recipes",
    type: "string",
  });

  // Eight launch flags registered here (the engine registers them so pi does not
  // reject them as unknown flags; recipe-loader consumes them at session_start /
  // before_agent_start). NOTE: --is-host is host-only and is NOT forwarded by
  // buildRecipeChildArgv to children; the other seven are forwarded as needed.
  pi.registerFlag("is-host", {
    description: "When set, this session is the mesh host — mesh-mux extension binds the launcher socket, processes initial_mesh:, and owns the PTY pool",
    type: "boolean",
  });
  pi.registerFlag("sandbox", {
    description: "Absolute path to the sandbox / working directory for this agent session",
    type: "string",
  });
  pi.registerFlag("task", {
    description: "Task text appended (trimmed) to the assembled system prompt at before_agent_start",
    type: "string",
  });
  pi.registerFlag("topology-overlay", {
    description: "JSON blob carrying peer relationship fields (escalatesTo, submitsWorkTo, acceptsWorkFrom, messagesWith, spawns) from a topology or atomic-delegate invocation",
    type: "string",
  });
  pi.registerFlag("peer-bus", {
    description: "Absolute path to the peer bus root directory (forwarded by mesh-mux and atomic-delegate; may be unused at runtime)",
    type: "string",
  });
  pi.registerFlag("inherit-pty", {
    description: "When set, this session's stdio is already inside a managed PTY; skip nested PTY allocation",
    type: "boolean",
  });
  pi.registerFlag("debug", {
    description: "Set Habitat.debug = true; rails dump diagnostics on session_start",
    type: "boolean",
  });
  pi.registerFlag("peer-name", {
    description: "Override the agent's instance name (used as the bus socket identity and display name)",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    const recipeName = (pi.getFlag("recipe") as string | undefined)?.trim();

    // Loaded-but-inert: no --recipe flag → do nothing.
    if (!recipeName) return;

    // ── Resolve the recipe (project → global → bundled) ───────────────────────

    const recipeDirs = getRecipeDirs(ctx.cwd);
    const templateDirs = getTemplateDirs(ctx.cwd);

    let recipe;
    try {
      recipe = resolveRecipe(recipeName, { recipeDirs, templateDirs });
    } catch (e) {
      ctx.ui.notify(
        `recipe-loader: ${(e as Error).message}`,
        "error",
      );
      return;
    }

    // ── Check that all referenced rail clusters are installed ──────────────────

    if (recipe.extensions.length > 0) {
      let railCheckResult;
      try {
        railCheckResult = resolveRailPackages(recipe.extensions, discoverInstalledPackages());
      } catch (e) {
        ctx.ui.notify(`recipe-loader: ${(e as Error).message}`, "error");
        return;
      }
      if (railCheckResult.missing.length > 0) {
        const lines = railCheckResult.missing.map(
          (m) => `  rail '${m.rail}' requires cluster '${m.cluster}' — install with: ${m.hint}`,
        );
        ctx.ui.notify(
          `recipe-loader: missing rail cluster(s):\n${lines.join("\n")}`,
          "error",
        );
        return;
      }
    }

    // ── Resolve skills ────────────────────────────────────────────────────────

    if (recipe.skills.length > 0) {
      const skillDirs = getSkillDirs(ctx.cwd);
      try {
        const resolvedSkillPaths = resolveSkills(recipe.skills, skillDirs);
        // Skills are stored as absolute paths in the Habitat; we pass them through
        // by updating the recipe's skills array before building the Habitat.
        recipe = { ...recipe, skills: resolvedSkillPaths };
      } catch (e) {
        ctx.ui.notify(`recipe-loader: ${(e as Error).message}`, "warning");
        // Continue without resolved skills — non-fatal.
      }
    }

    // ── Resolve the model ─────────────────────────────────────────────────────

    let concreteModelId: string;
    try {
      const bundledDefaults = loadBundledDefaults();
      const overrideConfig = loadOverrideConfig();
      concreteModelId = resolveModel(
        recipe.model,
        process.env as Record<string, string | undefined>,
        overrideConfig,
        bundledDefaults,
      );
    } catch (e) {
      ctx.ui.notify(`recipe-loader: ${(e as Error).message}`, "error");
      return;
    }

    // ── Read launch flags ─────────────────────────────────────────────────────

    // --peer-name overrides instance identity; falls back to sessionId then recipeName.
    const peerNameFlag = (pi.getFlag("peer-name") as string | undefined)?.trim();
    const instanceName = peerNameFlag || ctx.sessionId || recipeName;

    // --sandbox overrides the working directory / scratchRoot.
    const sandboxFlag = (pi.getFlag("sandbox") as string | undefined)?.trim();
    const cwd = sandboxFlag ? path.resolve(sandboxFlag) : ctx.cwd;

    // --debug sets Habitat.debug.
    const debugFlag = Boolean(pi.getFlag("debug"));

    // --is-host marks this session as the mesh host.
    const isHostFlag = Boolean(pi.getFlag("is-host"));

    // --topology-overlay carries peer relationship fields from the launcher.
    const topologyOverlayJson = (pi.getFlag("topology-overlay") as string | undefined)?.trim() ?? "";

    // ── Build and set Habitat ─────────────────────────────────────────────────

    const habitatOpts: {
      instanceName: string;
      cwd: string;
      flags: { debug?: boolean; isHost?: boolean };
      recipe: typeof recipe;
      peerFields?: import("../lib/build-habitat.js").PeerFields;
      spawns?: string[];
    } = {
      instanceName,
      cwd,
      flags: { debug: debugFlag, isHost: isHostFlag },
      recipe,
    };

    // Merge topology overlay — on invalid JSON, notify the user and bail out.
    if (topologyOverlayJson) {
      try {
        mergeTopologyOverlay(habitatOpts, topologyOverlayJson);
        // If spawns was overridden by the overlay, patch the recipe object so
        // buildHabitat picks it up from recipe.spawns as well.
        if (habitatOpts.spawns !== undefined) {
          recipe = { ...recipe, spawns: habitatOpts.spawns };
        }
        // Re-assign recipe with peerFields — buildHabitat reads them from peerFields separately.
      } catch (e) {
        ctx.ui.notify(
          `recipe-loader: --topology-overlay invalid JSON: ${(e as Error).message}`,
          "error",
        );
        return;
      }
    }

    const habitat = buildHabitat({
      instanceName: habitatOpts.instanceName,
      cwd: habitatOpts.cwd,
      flags: habitatOpts.flags,
      recipe,
      peerFields: habitatOpts.peerFields,
    });

    // NOTE: --is-host flag is NOT forwarded to children via buildRecipeChildArgv.
    // isHost is a host-only launch property; workers always get isHost = false.

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

  // Inject the assembled system prompt for every agent turn when a recipe is active.
  pi.on("before_agent_start", async (_event, ctx) => {
    const recipeName = (pi.getFlag("recipe") as string | undefined)?.trim();
    if (!recipeName) return undefined;

    // Re-resolve the recipe each time to keep this handler pure.
    // This is fast (disk read) and avoids module-level state.
    const recipeDirs = getRecipeDirs(ctx.cwd);
    const templateDirs = getTemplateDirs(ctx.cwd);

    let recipe;
    try {
      recipe = resolveRecipe(recipeName, { recipeDirs, templateDirs });
    } catch {
      return undefined;
    }

    if (!recipe.prompt) return undefined;

    // Determine supervisory status from the current Habitat (if set).
    // Import lazily to avoid circular issues; getHabitat may return null when
    // the extension is loaded but session_start hasn't run yet.
    let hasSupervisoryHabitat = false;
    try {
      const { getHabitat } = await import("../lib/habitat-glue.js");
      const habitat = getHabitat();
      if (habitat) {
        hasSupervisoryHabitat =
          Boolean(habitat.supervisor) ||
          Boolean(habitat.submitsWorkTo) ||
          (Array.isArray(habitat.acceptsWorkFrom) && habitat.acceptsWorkFrom.length > 0);
      }
    } catch {
      // habitat-glue not available — treat as non-supervisory
    }

    // Assemble the full system prompt with extension fragments.
    let systemPrompt = assemblePrompt({
      extensionNames: recipe.extensions,
      recipePrompt: recipe.prompt,
      hasSupervisoryHabitat,
      readFragment: readExtensionFragment,
    });

    // --task text (from mesh-mux / atomic-delegate) is appended to the
    // assembled system prompt as per-instance role context.
    const taskFlag = (pi.getFlag("task") as string | undefined)?.trim();
    if (taskFlag) {
      systemPrompt = `${systemPrompt}\n\n${taskFlag}`;
    }

    return { systemPrompt };
  });
}
