// group-membership.ts — unified group-membership aggregator.
// Canonical engine copy. The project-local .mjs at
// pi-sandbox/.pi/extensions/_lib/group-membership.mjs is a legacy copy
// kept for topology-validator.mjs consumers; this file is canonical.
//
// Exports:
//   aggregateGroupMembership(topo)  — legacy topology-shaped builder (unchanged)
//   buildGroupMap(entries)          — spawner-scoped builder for CohortRegistry use

import { effectiveGroups } from "./visibility.js";

export interface NodeWithGroups {
  name?: string;
  groups?: string[];
  [key: string]: unknown;
}

export interface TopologyLike {
  groups?: Record<string, string[]>;
  nodes: NodeWithGroups[];
  [key: string]: unknown;
}

/**
 * Build a unified group → members map by merging the top-level `groups:` block
 * with the per-node `groups: [...]` field. Legacy topology-shaped builder —
 * kept unchanged for consumers of the original mjs file.
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
 */
export function aggregateGroupMembership(topo: TopologyLike): Map<string, string[]> {
  const result = new Map<string, string[]>();

  // Pass 1: seed from the top-level groups block (preserving entry order).
  if (topo.groups && typeof topo.groups === "object" && !Array.isArray(topo.groups)) {
    for (const [groupName, members] of Object.entries(topo.groups)) {
      if (!Array.isArray(members)) continue;
      const deduped: string[] = [];
      const seen = new Set<string>();
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
      const members = result.get(groupName)!;
      if (!members.includes(name)) {
        members.push(name);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Spawner-scoped builder — for CohortRegistry use
// ---------------------------------------------------------------------------

export interface GroupMapEntry {
  /** Peer (instance) name. */
  peer: string;
  /** Group names this peer belongs to. Empty → implicit `_default`. */
  groups: string[];
}

/**
 * Build a group → peer[] map from a flat list of entries.
 * - If a peer's `groups` is empty, it joins `["_default"]` implicitly.
 * - Members are deduplicated within each group (first-occurrence order,
 *   insertion order preserved).
 */
export function buildGroupMap(entries: GroupMapEntry[]): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const entry of entries) {
    const groups = effectiveGroups(entry.groups);
    for (const g of groups) {
      if (!result.has(g)) result.set(g, []);
      const members = result.get(g)!;
      if (!members.includes(entry.peer)) {
        members.push(entry.peer);
      }
    }
  }

  return result;
}
