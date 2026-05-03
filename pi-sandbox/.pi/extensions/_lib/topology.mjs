import { parse as parseYaml } from "yaml";
import { aggregateGroupMembership } from "./group-membership.mjs";
import { resolveRef } from "./ref-resolver.mjs";

/**
 * @typedef {{
 *   name?: string;
 *   recipe?: string;
 *   type?: "relay";
 *   sandbox?: string;
 *   task?: string;
 *   supervisor?: string;
 *   submitTo?: string;
 *   acceptedFrom?: string[];
 *   peers?: string[];
 *   groups?: string[];
 * }} TopologyNode
 */

/**
 * @typedef {{
 *   supervisor?: string;
 *   submitTo?: string;
 *   acceptedFrom?: string[];
 *   peers?: string[];
 * }} GroupBinding
 */

/**
 * @typedef {{
 *   entry?: string;
 *   bus_root?: string;
 *   groups?: Record<string, string[]>;
 *   group_bindings?: Record<string, GroupBinding>;
 *   nodes: TopologyNode[];
 * }} Topology
 */

/**
 * @typedef {{
 *   supervisor?: string;
 *   submitTo?: string;
 *   acceptedFrom: string[];
 *   peers: string[];
 *   _resolutions: Array<{field: string; group: string; member: string; policy: "round-robin"}>;
 * }} ResolvedNode
 */

/**
 * @param {string} yamlText
 * @returns {Topology}
 */
export function parseTopology(yamlText) {
  const raw = parseYaml(yamlText);

  if (!raw || typeof raw !== "object") throw new Error("topology: YAML must be a mapping");
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new Error("topology: 'nodes' must be a non-empty array");
  }

  const nodes = raw.nodes.map((n, idx) => {
    if (!n || typeof n !== "object") throw new Error(`topology: node[${idx}] must be a mapping`);
    return {
      ...(typeof n.name === "string" && n.name ? { name: n.name } : {}),
      ...(typeof n.recipe === "string" ? { recipe: n.recipe } : {}),
      ...(n.type === "relay" ? { type: /** @type {"relay"} */ ("relay") } : {}),
      ...(typeof n.sandbox === "string" ? { sandbox: n.sandbox } : {}),
      ...(typeof n.task === "string" ? { task: n.task } : {}),
      ...(typeof n.supervisor === "string" ? { supervisor: n.supervisor } : {}),
      ...(typeof n.submitTo === "string" ? { submitTo: n.submitTo } : {}),
      ...(Array.isArray(n.acceptedFrom)
        ? { acceptedFrom: n.acceptedFrom.filter((s) => typeof s === "string") }
        : {}),
      ...(Array.isArray(n.peers)
        ? { peers: n.peers.filter((s) => typeof s === "string") }
        : {}),
      ...(Array.isArray(n.groups)
        ? { groups: n.groups.filter((s) => typeof s === "string") }
        : {}),
    };
  });

  // Reject duplicate names among the named nodes (unnamed nodes get assigned
  // names later by the launcher and are checked again post-assignment).
  const seen = new Set();
  for (const node of nodes) {
    if (!node.name) continue;
    if (seen.has(node.name)) throw new Error(`topology: duplicate node name: '${node.name}'`);
    seen.add(node.name);
  }

  /** @type {Topology} */
  const topo = { nodes };

  if (typeof raw.entry === "string" && raw.entry) topo.entry = raw.entry;
  if (typeof raw.bus_root === "string") topo.bus_root = raw.bus_root;

  if (raw.groups && typeof raw.groups === "object" && !Array.isArray(raw.groups)) {
    /** @type {Record<string, string[]>} */
    const groups = {};
    for (const [k, v] of Object.entries(raw.groups)) {
      if (!Array.isArray(v)) throw new Error(`topology: groups.${k} must be an array`);
      groups[k] = v.filter((s) => typeof s === "string");
    }
    topo.groups = groups;
  }

  if (
    raw.group_bindings &&
    typeof raw.group_bindings === "object" &&
    !Array.isArray(raw.group_bindings)
  ) {
    /** @type {Record<string, GroupBinding>} */
    const bindings = {};
    for (const [k, v] of Object.entries(raw.group_bindings)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        throw new Error(`topology: group_bindings.${k} must be a mapping`);
      }
      /** @type {GroupBinding} */
      const binding = {};
      if (typeof v.supervisor === "string") binding.supervisor = v.supervisor;
      if (typeof v.submitTo === "string") binding.submitTo = v.submitTo;
      if (Array.isArray(v.acceptedFrom))
        binding.acceptedFrom = v.acceptedFrom.filter((s) => typeof s === "string");
      if (Array.isArray(v.peers))
        binding.peers = v.peers.filter((s) => typeof s === "string");
      bindings[k] = binding;
    }
    topo.group_bindings = bindings;
  }

  return topo;
}

/**
 * Expand a list that may contain @<group> references into concrete peer names.
 * Uses the expand-all policy so every member of a referenced group is included.
 * @param {string[]} list
 * @param {Map<string, string[]> | undefined} groups
 * @param {string} context
 * @returns {string[]}
 */
function expandRefs(list, groups, context) {
  const result = [];
  for (const item of list) {
    if (item.startsWith("@")) {
      const groupName = item.slice(1);
      const members = groups?.get(groupName);
      try {
        const expanded = /** @type {string[]} */ (resolveRef(item, members, "expand-all", undefined));
        result.push(...expanded);
      } catch (e) {
        // Translate to the legacy wording so existing tests stay green
        throw new Error(`topology: unknown group reference '@${groupName}' in ${context}`);
      }
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * Returns the effective Habitat-overlay fields for one node.
 * Resolution order: group_bindings (last group wins) → per-node overrides.
 * @param {Topology} topo
 * @param {string} nodeName
 * @param {Map<string, {value: number}>} [counterStates] — mutable round-robin counters keyed
 *   by group name; shared across all resolveNode calls by the launcher so that consecutive
 *   nodes targeting the same group land on different members. Lazily initialised to a fresh
 *   Map when omitted so existing call sites without the parameter still work.
 * @returns {ResolvedNode}
 */
export function resolveNode(topo, nodeName, counterStates) {
  // Default to a fresh empty Map so callers that omit the arg still work.
  if (!counterStates) counterStates = new Map();

  const node = topo.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`topology: node '${nodeName}' not found in topology`);

  const nodeNames = new Set(topo.nodes.map((n) => n.name));
  // Use the aggregator so per-node groups: declarations participate in @group expansion.
  const groups = aggregateGroupMembership(topo);

  // Collect all groups this node belongs to (order: groups in declaration order)
  const memberGroups = [];
  for (const [groupName, members] of groups) {
    if (members.includes(nodeName)) memberGroups.push(groupName);
  }

  // Apply group_bindings in declaration order; later groups overwrite earlier
  // for scalar fields, and also replace array fields. Per-node fields win over all.
  let supervisor;
  let submitTo;
  let acceptedFrom;
  let peers;

  for (const groupName of memberGroups) {
    const binding = topo.group_bindings?.[groupName];
    if (!binding) continue;
    if (binding.supervisor !== undefined) supervisor = binding.supervisor;
    if (binding.submitTo !== undefined) submitTo = binding.submitTo;
    if (binding.acceptedFrom !== undefined) acceptedFrom = binding.acceptedFrom;
    if (binding.peers !== undefined) peers = binding.peers;
  }

  // Per-node values override bindings
  if (node.supervisor !== undefined) supervisor = node.supervisor;
  if (node.submitTo !== undefined) submitTo = node.submitTo;
  if (node.acceptedFrom !== undefined) acceptedFrom = node.acceptedFrom;
  if (node.peers !== undefined) peers = node.peers;

  // Expand @group refs
  const resolvedAcceptedFrom = expandRefs(acceptedFrom ?? [], groups, `node '${nodeName}'.acceptedFrom`);
  const resolvedPeers = expandRefs(peers ?? [], groups, `node '${nodeName}'.peers`);

  // Validate that all concrete names exist in the topology
  for (const name of resolvedAcceptedFrom) {
    if (!nodeNames.has(name)) {
      throw new Error(`topology: node '${nodeName}'.acceptedFrom references unknown node '${name}'`);
    }
  }
  for (const name of resolvedPeers) {
    if (!nodeNames.has(name)) {
      throw new Error(`topology: node '${nodeName}'.peers references unknown node '${name}'`);
    }
  }

  /** @type {Array<{field: string; group: string; member: string; policy: "round-robin"}>} */
  const resolutions = [];

  /**
   * Resolve a scalar field that may be an @group ref using round-robin policy.
   * Returns the concrete string value and populates `resolutions` on `@` refs.
   * @param {string | undefined} value
   * @param {string} field
   * @returns {string | undefined}
   */
  function resolveScalar(value, field) {
    if (value === undefined || !value.startsWith("@")) return value;
    const groupName = value.slice(1);
    const members = groups.get(groupName);
    // Lazily create the counter for this group if it doesn't exist yet.
    if (!counterStates.has(groupName)) counterStates.set(groupName, { value: 0 });
    const counter = counterStates.get(groupName);
    try {
      const member = /** @type {string} */ (resolveRef(value, members, "round-robin", counter));
      resolutions.push({ field, group: groupName, member, policy: "round-robin" });
      return member;
    } catch (e) {
      // Translate to include field context
      throw new Error(`topology: node '${nodeName}'.${field}: ${e.message}`);
    }
  }

  const resolvedSupervisor = resolveScalar(supervisor, "supervisor");
  const resolvedSubmitTo = resolveScalar(submitTo, "submitTo");

  // Validate resolved concrete scalar names exist in the topology
  if (resolvedSupervisor !== undefined && !nodeNames.has(resolvedSupervisor)) {
    throw new Error(`topology: node '${nodeName}'.supervisor references unknown node '${resolvedSupervisor}'`);
  }
  if (resolvedSubmitTo !== undefined && !nodeNames.has(resolvedSubmitTo)) {
    throw new Error(`topology: node '${nodeName}'.submitTo references unknown node '${resolvedSubmitTo}'`);
  }

  /** @type {ResolvedNode} */
  const result = {
    acceptedFrom: resolvedAcceptedFrom,
    peers: resolvedPeers,
    _resolutions: resolutions,
  };
  if (resolvedSupervisor !== undefined) result.supervisor = resolvedSupervisor;
  if (resolvedSubmitTo !== undefined) result.submitTo = resolvedSubmitTo;
  return result;
}
