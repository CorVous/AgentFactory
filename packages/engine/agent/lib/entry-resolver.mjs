// CANONICAL COPY: packages/engine/agent/lib/entry-resolver.mjs
// The project-local .mjs copy at pi-sandbox/.pi/extensions/_lib/entry-resolver.mjs
// has been removed (Slice 5); this is the canonical copy.
/**
 * entry-resolver.mjs — resolves the `entry:` field in a topology to a concrete
 * peer name, and provides the crash-auto-shift target (the top supervisor).
 *
 * This module is a pure function over the topology data — no live model, no
 * network, no filesystem.
 *
 * Relationships to other modules:
 *   - Works with the parsed topology shape from topology.mjs / topology-validator.mjs.
 *   - Used by focus-controller (later slice) for crash auto-shift.
 *   - Missing `entry:` synthesises from the unique top supervisor (callers should
 *     run validateTopology first to guarantee uniqueness).
 */

import { aggregateGroupMembership } from "./group-membership.mjs";
import { resolveRef } from "./ref-resolver.mjs";

/**
 * @typedef {{
 *   entry?: string;
 *   groups?: Record<string, string[]>;
 *   group_bindings?: Record<string, {escalatesTo?: string; [key: string]: any}>;
 *   nodes: Array<{name: string; recipe?: string; type?: "relay"; escalatesTo?: string; groups?: string[]; [key: string]: any}>;
 * }} Topology
 */

/**
 * @typedef {{
 *   entryPeer: string | null;
 *   topSupervisor: string | null;
 *   errors: string[];
 * }} EntryResolveResult
 */

/**
 * Return true when the string value represents a set escalatesTo (non-undefined,
 * and if it's an @group ref, the group resolves to ≥1 member).
 *
 * This mirrors the `escalatesToIsSet` helper in validateTopology so both modules
 * compute top-supervisor candidates identically.
 *
 * @param {string | undefined} value
 * @param {Map<string, string[]>} groups
 * @returns {boolean}
 */
function escalatesToIsSet(value, groups) {
  if (value === undefined) return false;
  if (!value.startsWith("@")) return true; // concrete name → always set
  const groupName = value.slice(1);
  const members = groups.get(groupName);
  // Unknown group or empty group → treat as "unset"
  if (!members || members.length === 0) return false;
  return true;
}

/**
 * Resolve the `entry:` field and top supervisor from a topology.
 *
 * Three paths for `entry:`:
 *   - Omitted: synthesises from the unique top supervisor (entryPeer == topSupervisor).
 *     Returns entryPeer = null (no error) when top supervisor is non-unique — callers
 *     must run validateTopology first to guarantee uniqueness.
 *   - `@group` ref: resolves to the first-listed member of the group. Pushes a distinct
 *     error for unknown group or zero members.
 *   - Concrete name: must be in nodeNames; pushes an error otherwise.
 *
 * `topSupervisor` is the single node with no effective escalatesTo (null when zero or
 * multiple candidates).
 *
 * @param {Topology} topo
 * @returns {EntryResolveResult}
 */
export function resolveEntry(topo) {
  const errors = [];
  const nodeNames = new Set(topo.nodes.map((n) => n.name));

  // ── Resolve top supervisor ─────────────────────────────────────────────────
  // Uses aggregateGroupMembership so per-node groups: declarations participate,
  // mirroring validateTopology Rule 3 exactly.
  const groups = aggregateGroupMembership(topo);

  const topCandidates = [];
  for (const node of topo.nodes) {
    if (node.type === "relay") continue;
    if (node.type !== undefined) continue; // skip nodes with unknown types

    let effectiveEscalatesTo;

    // Group_bindings (last group wins)
    if (topo.group_bindings) {
      for (const [groupName, members] of groups) {
        if (members.includes(node.name)) {
          const binding = topo.group_bindings[groupName];
          if (binding?.escalatesTo !== undefined) {
            effectiveEscalatesTo = binding.escalatesTo;
          }
        }
      }
    }

    // Per-node escalatesTo overrides group_bindings
    if (node.escalatesTo !== undefined) {
      effectiveEscalatesTo = node.escalatesTo;
    }

    if (!escalatesToIsSet(effectiveEscalatesTo, groups)) {
      topCandidates.push(node.name);
    }
  }

  const topSupervisor =
    topCandidates.length === 1 ? topCandidates[0] : null;

  // ── Resolve entry ──────────────────────────────────────────────────────────
  let entryPeer = null;

  if (topo.entry === undefined || topo.entry === null || topo.entry === "") {
    // Synthesis path: use the unique top supervisor (null when non-unique).
    // No error is pushed here — non-unique top supervisor is validated by
    // validateTopology; callers should run that first.
    entryPeer = topSupervisor;
  } else if (topo.entry.startsWith("@")) {
    // @group path: resolve to first-listed member.
    const groupName = topo.entry.slice(1);
    const members = groups.get(groupName);
    try {
      const resolved = /** @type {string} */ (resolveRef(topo.entry, members, "first-listed", undefined));
      entryPeer = resolved;
    } catch (e) {
      if (/zero members/.test(e.message)) {
        errors.push(
          `'entry: ${topo.entry}' resolves to zero members — group '@${groupName}' is empty`,
        );
      } else {
        errors.push(
          `'entry: ${topo.entry}' references unknown group '@${groupName}' — group is not defined`,
        );
      }
    }
  } else if (!nodeNames.has(topo.entry)) {
    errors.push(
      `'entry: ${topo.entry}' does not match any node name in the topology`,
    );
  } else {
    entryPeer = topo.entry;
  }

  return { entryPeer, topSupervisor, errors };
}

/**
 * Returns the name to focus on after an entry-peer crash.
 *
 * Per ADR-0004: when the current focused peer crashes, focus auto-shifts to
 * the top supervisor. If the top supervisor can't be resolved uniquely, returns
 * null (caller should treat this as "leave focus undefined").
 *
 * @param {Topology} topo
 * @returns {string | null}
 */
export function crashAutoShiftTarget(topo) {
  const { topSupervisor } = resolveEntry(topo);
  return topSupervisor;
}
