// resolve-model.ts — resolves a model field (tier-var name or literal ID)
// to a concrete model ID string.
//
// Pure: no I/O, no process.env access. The caller passes the environment
// map, the override config, and the bundled defaults explicitly so this
// module is hermetically testable.

export const TIER_VARS = new Set([
  "RABBIT_SAGE_MODEL",
  "LEAD_HARE_MODEL",
  "TASK_RABBIT_MODEL",
]);

/**
 * Resolve a recipe's `model:` field to a concrete model ID.
 *
 * Cascade (first non-empty value wins):
 *   1. env[tier]          — environment variable (e.g. process.env)
 *   2. overrideConfig[tier] — user override file (~/.pi/agent/models.json)
 *   3. bundledDefaults[tier] — bundled default map shipped with the package
 *
 * If `tierOrId` is NOT in TIER_VARS it is returned unchanged (literal passthrough).
 * If it IS a tier name but none of the three sources resolve it, an Error is thrown.
 *
 * @param tierOrId       - The value from recipe.model (tier var name or literal ID).
 * @param env            - Environment map (e.g. process.env).
 * @param overrideConfig - Parsed override file (~/.pi/agent/models.json), or {}.
 * @param bundledDefaults - Bundled default tier→model-ID map.
 * @returns The concrete model ID string.
 * @throws {Error} When `tierOrId` is a known tier var name but cannot be resolved.
 */
export function resolveModel(
  tierOrId: string,
  env: Record<string, string | undefined>,
  overrideConfig: Record<string, string>,
  bundledDefaults: Record<string, string>,
): string {
  // Not a tier var — pass through unchanged.
  if (!TIER_VARS.has(tierOrId)) {
    return tierOrId;
  }

  // Cascade: env → override → bundled
  const fromEnv = env[tierOrId];
  if (fromEnv) return fromEnv;

  const fromOverride = overrideConfig[tierOrId];
  if (fromOverride) return fromOverride;

  const fromBundled = bundledDefaults[tierOrId];
  if (fromBundled) return fromBundled;

  throw new Error(
    `resolveModel: tier var '${tierOrId}' is unresolvable — set the env var, add it to ~/.pi/agent/models.json, or check the bundled defaults`,
  );
}
