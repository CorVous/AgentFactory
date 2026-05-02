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
 *   - Missing `entry:` is caught here as an error (delegated from validator).
 */

/**
 * @typedef {{
 *   entry?: string;
 *   groups?: Record<string, string[]>;
 *   group_bindings?: Record<string, {supervisor?: string; [key: string]: any}>;
 *   nodes: Array<{name: string; recipe?: string; type?: "relay"; supervisor?: string; [key: string]: any}>;
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
 * Resolve the `entry:` field and top supervisor from a topology.
 *
 * - `entryPeer` is the name named by `topology.entry`.
 * - `topSupervisor` is the single node with no effective supervisor.
 * - If `entry:` is missing or invalid, an error is returned.
 *
 * @param {Topology} topo
 * @returns {EntryResolveResult}
 */
export function resolveEntry(topo) {
  const errors = [];
  const nodeNames = new Set(topo.nodes.map((n) => n.name));

  // ── Resolve entry ──────────────────────────────────────────────────────────
  let entryPeer = null;

  if (!topo.entry) {
    errors.push("topology is missing required 'entry:' field");
  } else if (!nodeNames.has(topo.entry)) {
    errors.push(
      `'entry: ${topo.entry}' does not match any node name in the topology`,
    );
  } else {
    entryPeer = topo.entry;
  }

  // ── Resolve top supervisor ─────────────────────────────────────────────────
  // The top supervisor is the node with no effective supervisor (after applying
  // group_bindings). This mirrors the logic in validateTopology.
  const topCandidates = [];
  for (const node of topo.nodes) {
    if (node.type === "relay") continue;

    let effectiveSupervisor;

    // Group_bindings (last group wins)
    if (topo.groups && topo.group_bindings) {
      for (const [groupName, members] of Object.entries(topo.groups)) {
        if (members.includes(node.name)) {
          const binding = topo.group_bindings[groupName];
          if (binding?.supervisor !== undefined) {
            effectiveSupervisor = binding.supervisor;
          }
        }
      }
    }

    // Per-node supervisor overrides group_bindings
    if (node.supervisor !== undefined) {
      effectiveSupervisor = node.supervisor;
    }

    if (effectiveSupervisor === undefined) {
      topCandidates.push(node.name);
    }
  }

  const topSupervisor =
    topCandidates.length === 1 ? topCandidates[0] : null;

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
