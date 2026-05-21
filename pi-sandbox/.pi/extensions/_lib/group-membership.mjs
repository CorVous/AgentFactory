// CANONICAL COPY: packages/engine/agent/lib/group-membership.ts (TypeScript)
// This .mjs file is kept for topology-validator.mjs / launch-mesh.mjs consumers.
/**
 * group-membership.mjs — unified group-membership aggregator.
 *
 * Merges the two forms in which a node can declare group membership:
 *
 *   1. Top-level `groups:` block  — classic form; enumerated in the topology root.
 *   2. Per-node `groups: [...]`   — inline form; each named node declares its own memberships.
 *
 * Callers (resolveNode, validateTopology) can use the returned Map in place of
 * direct reads of `topo.groups` so both forms participate in @group expansion.
 */

/**
 * @typedef {{
 *   name?: string;
 *   groups?: string[];
 *   [key: string]: unknown;
 * }} NodeWithGroups
 */

/**
 * @typedef {{
 *   groups?: Record<string, string[]>;
 *   nodes: NodeWithGroups[];
 *   [key: string]: unknown;
 * }} TopologyLike
 */

/**
 * Build a unified group → members map by merging the top-level `groups:` block
 * with the per-node `groups: [...]` field.
 *
 * Resolution order:
 *   1. Seed from `topo.groups` (top-level), preserving declaration order and
 *      deduplicating within each group.
 *   2. For each node (in declaration order) whose `name` is non-empty and whose
 *      `groups` list is non-empty, append the node name to each declared group,
 *      creating the group implicitly if it was not in the top-level block.
 *      Anonymous nodes (no `name`) are silently skipped.
 *
 * Deduplication uses first-occurrence order: top-level members always appear
 * before per-node additions; among per-node additions, declaration order is preserved.
 *
 * @param {TopologyLike} topo
 * @returns {Map<string, string[]>}
 */
export function aggregateGroupMembership(topo) {
  /** @type {Map<string, string[]>} */
  const result = new Map();

  // Pass 1: seed from the top-level groups block (preserving entry order).
  if (topo.groups && typeof topo.groups === "object" && !Array.isArray(topo.groups)) {
    for (const [groupName, members] of Object.entries(topo.groups)) {
      if (!Array.isArray(members)) continue;
      const deduped = [];
      const seen = new Set();
      for (const m of members) {
        if (typeof m === "string" && !seen.has(m)) {
          deduped.push(m);
          seen.add(m);
        }
      }
      result.set(groupName, deduped);
    }
  }

  // Pass 2: append per-node memberships (nodes in declaration order).
  for (const node of topo.nodes) {
    const name = node.name;
    if (!name || typeof name !== "string") continue; // skip anonymous nodes
    if (!Array.isArray(node.groups) || node.groups.length === 0) continue;

    for (const groupName of node.groups) {
      if (typeof groupName !== "string") continue;

      if (!result.has(groupName)) {
        result.set(groupName, []);
      }
      const members = /** @type {string[]} */ (result.get(groupName));
      if (!members.includes(name)) {
        members.push(name);
      }
    }
  }

  return result;
}
