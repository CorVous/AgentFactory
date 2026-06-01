// resolve-model-from-registry.ts — resolves a recipe model string to a registry
// Model, preferring the session's active provider so OpenRouter-style ids (which
// contain '/') resolve correctly.
//
// Pure: no I/O, no process.env access. The caller passes the registry and the
// active provider explicitly so this module is hermetically testable.

import type { Api, Model } from "@earendil-works/pi-ai";

export interface RegistryLike {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getAll(): Model<Api>[];
}

/**
 * Resolve a recipe model string to a registry Model, preferring the session's
 * active provider so OpenRouter-style ids (which contain '/') resolve correctly.
 *
 * Precedence:
 *   1. activeProvider set → find(activeProvider, fullModelString)   // whole slug is the id
 *   2. first-slash split  → find(prefix, rest)                       // genuine provider/id
 *   3. no/failed split    → getAll().find(m => m.id === fullModelString)
 *
 * @param registry       - The pi model registry.
 * @param modelString    - The concrete model ID string (e.g. "deepseek/deepseek-v3.2").
 * @param activeProvider - The session's active provider (from ctx.model?.provider), or undefined.
 * @returns The matching Model entry, or undefined if not found.
 */
export function resolveModelFromRegistry(
  registry: RegistryLike,
  modelString: string,
  activeProvider: string | undefined,
): Model<Api> | undefined {
  // Step 1: If there's an active provider, try treating the entire model string
  // as the model id under that provider. This is the correct resolution for
  // OpenRouter slugs like "deepseek/deepseek-v3.2" or "google/gemini-2.5-flash-lite"
  // which are stored as full slugs under provider "openrouter".
  if (activeProvider) {
    const underActive = registry.find(activeProvider, modelString);
    if (underActive) return underActive;
  }

  // Step 2: Try splitting on the first '/' and treating the prefix as the
  // provider and the rest as the model id. This handles genuine "provider/id"
  // strings like "anthropic/claude-sonnet-4".
  const slashIdx = modelString.indexOf("/");
  if (slashIdx !== -1) {
    const provider = modelString.slice(0, slashIdx);
    const modelId = modelString.slice(slashIdx + 1);
    const split = registry.find(provider, modelId);
    if (split) return split;
  }

  // Step 3: Fall back to a full id scan across all models in the registry.
  // Handles no-slash ids like "gemini-2.5-flash-lite".
  return registry.getAll().find((m) => m.id === modelString);
}
