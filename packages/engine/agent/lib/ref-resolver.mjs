// CANONICAL COPY: packages/engine/agent/lib/ref-resolver.ts (TypeScript)
// This .mjs file is kept for topology*.mjs consumers that load via createRequire.
/**
 * ref-resolver.mjs — pure-function @group reference resolver.
 *
 * Resolves a single `@<group>` reference (or literal string) according to
 * a policy, using a caller-owned counter for round-robin selection.
 *
 * Policies:
 *   expand-all   → string[]  (all members; [literal] for non-@ ref)
 *   round-robin  → string    (one member, advancing counterState.value)
 *   first-listed → string    (members[0]; literal for non-@ ref)
 */

/**
 * Resolve a single ref (possibly `@<group>`) to a string or string[],
 * depending on the policy.
 *
 * @param {string} ref — raw YAML value, e.g. "@reviewers" or "reviewer-1"
 * @param {string[] | undefined} members — resolved member list for the group
 *   (undefined = group not declared; ignored for non-@ refs)
 * @param {"expand-all" | "round-robin" | "first-listed"} policy
 * @param {{ value: number } | undefined} counterState — mutable round-robin counter;
 *   required only when policy is "round-robin"
 * @returns {string | string[]} — string[] for expand-all; string for round-robin / first-listed
 */
export function resolveRef(ref, members, policy, counterState) {
  if (policy !== "expand-all" && policy !== "round-robin" && policy !== "first-listed") {
    throw new Error(`resolveRef: unknown policy '${policy}'`);
  }

  // Non-@ ref: pass through verbatim under all policies
  if (!ref.startsWith("@")) {
    if (policy === "expand-all") return [ref];
    return ref;
  }

  const groupName = ref.slice(1);

  // Unknown group
  if (members === undefined) {
    throw new Error(`unknown @group reference '@${groupName}'`);
  }

  // Empty group
  if (members.length === 0) {
    throw new Error(`@group reference '@${groupName}' resolves to zero members`);
  }

  if (policy === "expand-all") {
    return [...members];
  }

  if (policy === "round-robin") {
    if (!counterState || typeof counterState.value !== "number") {
      throw new Error(`resolveRef: round-robin requires a counterState object with a numeric 'value' field`);
    }
    const member = members[counterState.value % members.length];
    counterState.value++;
    return member;
  }

  // first-listed
  return members[0];
}
