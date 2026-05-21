// resolve-model.ts — resolves a model field (tier-var name or literal ID)
// to a concrete model ID string.
//
// Pure: no I/O, no process.env access. The caller passes the environment
// map explicitly so this module is hermetically testable.

const TIER_VARS = new Set(["RABBIT_SAGE_MODEL", "LEAD_HARE_MODEL", "TASK_RABBIT_MODEL"]);

/**
 * Resolve a recipe's `model:` field to a concrete model ID.
 *
 * @param modelField - The value from recipe.model (tier var name or literal ID).
 * @param env - Environment map to look up tier vars from (e.g. process.env).
 * @returns The concrete model ID string.
 * @throws {Error} When `modelField` is a known tier var name but is not set in `env`.
 */
export function resolveModel(
  modelField: string,
  env: Record<string, string | undefined>,
): string {
  if (TIER_VARS.has(modelField)) {
    const value = env[modelField];
    if (!value) {
      throw new Error(
        `resolveModel: tier var ${modelField} is not set; source models.env first`,
      );
    }
    return value;
  }
  // Literal model ID — pass through unchanged.
  return modelField;
}
