// recipe-validation.mjs — recipe validation helpers used by launch-mesh.mjs.
//
// rejectDeprecatedPeerFields: fails loudly if a recipe declares any of the
//   four peer-relationship fields that were deleted in #112. These fields have
//   moved exclusively to the topology layer.
//
// mergeBaselineTools: ensures the baseline tool set (respond_to_request) is
//   always present in a recipe's tools allowlist, regardless of whether the
//   recipe sets any supervisory peer fields.

const DEPRECATED_PEER_FIELDS = ["supervisor", "submitTo", "acceptedFrom", "peers"];

const DEPRECATED_MSG =
  (field) =>
    `recipe {{name}} declares '${field}' which is no longer accepted; ` +
    `peer wiring lives in the topology layer (see docs/agents.md ## Topology YAML)`;

/**
 * Throws (via die) if the recipe declares any of the four removed peer fields.
 * Called after basic recipe validation in loadRecipe().
 *
 * @param {Record<string, unknown>} recipe  - Parsed recipe object.
 * @param {string}                  name    - Recipe name (for error messages).
 * @param {(msg: string) => never}  die     - Error-and-exit function.
 */
export function rejectDeprecatedPeerFields(recipe, name, die) {
  for (const field of DEPRECATED_PEER_FIELDS) {
    if (recipe[field] !== undefined) {
      die(DEPRECATED_MSG(field).replace("{{name}}", name));
    }
  }
}

/**
 * Returns a deduplicated tools array that always includes every entry from
 * BASELINE_TOOLS (currently just `respond_to_request`).
 *
 * @param {string[]} tools - Recipe tools array.
 * @returns {string[]}
 */
export function mergeBaselineTools(tools) {
  const BASELINE_TOOLS = ["respond_to_request"];
  return [...new Set([...BASELINE_TOOLS, ...tools])];
}
