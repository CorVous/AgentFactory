// ref-resolver.ts — pure-function @group reference resolver.
// Canonical engine copy. The project-local .mjs at
// pi-sandbox/.pi/extensions/_lib/ref-resolver.mjs is kept for
// topology-validator.mjs/launch-mesh.mjs consumers; this file is canonical.
//
// Resolves a single `@<group>` reference (or literal string) according to
// a policy, using a caller-owned counter for round-robin selection.
//
// Policies:
//   expand-all   → string[]  (all members; [literal] for non-@ ref)
//   round-robin  → string    (one member, advancing counterState.value)
//   first-listed → string    (members[0]; literal for non-@ ref)

export type ResolvePolicy = "expand-all" | "round-robin" | "first-listed";
export type CounterState = { value: number };

/**
 * Resolve a single ref (possibly `@<group>`) to a string or string[],
 * depending on the policy.
 *
 * @param ref — raw YAML value, e.g. "@reviewers" or "reviewer-1"
 * @param members — resolved member list for the group
 *   (undefined = group not declared; ignored for non-@ refs)
 * @param policy
 * @param counterState — mutable round-robin counter;
 *   required only when policy is "round-robin"
 */
export function resolveRef(
  ref: string,
  members: string[] | undefined,
  policy: ResolvePolicy,
  counterState: CounterState | undefined,
): string | string[] {
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
      throw new Error(
        `resolveRef: round-robin requires a counterState object with a numeric 'value' field`,
      );
    }
    const member = members[counterState.value % members.length];
    counterState.value++;
    return member;
  }

  // first-listed
  return members[0];
}
