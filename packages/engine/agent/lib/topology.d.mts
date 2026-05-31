/**
 * topology.d.mts — TypeScript declarations for topology.mjs
 */

export interface TopologyNode {
  name?: string;
  recipe?: string;
  type?: "relay";
  sandbox?: string;
  task?: string;
  escalatesTo?: string;
  submitsWorkTo?: string;
  acceptsWorkFrom?: string[];
  messagesWith?: string[];
  groups?: string[];
}

export interface GroupBinding {
  escalatesTo?: string;
  submitsWorkTo?: string;
  acceptsWorkFrom?: string[];
  messagesWith?: string[];
}

export interface Topology {
  entry?: string;
  bus_root?: string;
  groups?: Record<string, string[]>;
  group_bindings?: Record<string, GroupBinding>;
  nodes: TopologyNode[];
}

export interface ResolvedNode {
  escalatesTo?: string;
  submitsWorkTo?: string;
  acceptsWorkFrom: string[];
  messagesWith: string[];
  _resolutions: Array<{
    field: string;
    group: string;
    member: string;
    policy: "round-robin";
  }>;
}

/**
 * Parse a YAML string into a validated Topology object.
 * Throws on invalid YAML, missing nodes, or duplicate node names.
 */
export function parseTopology(yamlText: string): Topology;

/**
 * Returns the effective Habitat-overlay fields for one node.
 * Resolution order: group_bindings (last group wins) → per-node overrides.
 * counterStates is an optional mutable map for round-robin counters.
 */
export function resolveNode(
  topo: Topology,
  nodeName: string,
  counterStates?: Map<string, { value: number }>,
): ResolvedNode;
