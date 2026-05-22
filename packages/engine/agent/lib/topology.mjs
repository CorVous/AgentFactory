// CANONICAL COPY: packages/engine/agent/lib/topology.mjs
// Legacy copy in pi-sandbox/.pi/extensions/_lib/topology.mjs is kept for
// backward compatibility with launch-mesh.mjs consumers.
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
 *   escalatesTo?: string;
 *   submitsWorkTo?: string;
 *   acceptsWorkFrom?: string[];
 *   messagesWith?: string[];
 *   groups?: string[];
 * }} TopologyNode
 */

/**
 * @typedef {{
 *   escalatesTo?: string;
 *   submitsWorkTo?: string;
 *   acceptsWorkFrom?: string[];
 *   messagesWith?: string[];
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
 *   escalatesTo?: string;
 *   submitsWorkTo?: string;
 *   acceptsWorkFrom: string[];
 *   messagesWith: string[];
 *   _resolutions: Array<{field: string; group: string; member: string; policy: "round-robin"}>;
 * }} ResolvedNode
 */

/**
 * @param {string} yamlText
 * @returns {Topology}
 */
export function parseTopology(yamlText) {
  const raw = parseYaml(yamlText);

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("topology: YAML must be a mapping");
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
      ...(typeof n.escalatesTo === "string" ? { escalatesTo: n.escalatesTo } : {}),
      ...(typeof n.submitsWorkTo === "string" ? { submitsWorkTo: n.submitsWorkTo } : {}),
      ...(Array.isArray(n.acceptsWorkFrom)
        ? { acceptsWorkFrom: n.acceptsWorkFrom.filter((s) => typeof s === "string") }
        : {}),
      ...(Array.isArray(n.messagesWith)
        ? { messagesWith: n.messagesWith.filter((s) => typeof s === "string") }
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
      if (typeof v.escalatesTo === "string") binding.escalatesTo = v.escalatesTo;
      if (typeof v.submitsWorkTo === "string") binding.submitsWorkTo = v.submitsWorkTo;
      if (Array.isArray(v.acceptsWorkFrom))
        binding.acceptsWorkFrom = v.acceptsWorkFrom.filter((s) => typeof s === "string");
      if (Array.isArray(v.messagesWith))
        binding.messagesWith = v.messagesWith.filter((s) => typeof s === "string");
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
  let escalatesTo;
  let submitsWorkTo;
  let acceptsWorkFrom;
  let messagesWith;

  for (const groupName of memberGroups) {
    const binding = topo.group_bindings?.[groupName];
    if (!binding) continue;
    if (binding.escalatesTo !== undefined) escalatesTo = binding.escalatesTo;
    if (binding.submitsWorkTo !== undefined) submitsWorkTo = binding.submitsWorkTo;
    if (binding.acceptsWorkFrom !== undefined) acceptsWorkFrom = binding.acceptsWorkFrom;
    if (binding.messagesWith !== undefined) messagesWith = binding.messagesWith;
  }

  // Per-node values override bindings
  if (node.escalatesTo !== undefined) escalatesTo = node.escalatesTo;
  if (node.submitsWorkTo !== undefined) submitsWorkTo = node.submitsWorkTo;
  if (node.acceptsWorkFrom !== undefined) acceptsWorkFrom = node.acceptsWorkFrom;
  if (node.messagesWith !== undefined) messagesWith = node.messagesWith;

  // Expand @group refs
  const resolvedAcceptsWorkFrom = expandRefs(acceptsWorkFrom ?? [], groups, `node '${nodeName}'.acceptsWorkFrom`);
  const resolvedMessagesWith = expandRefs(messagesWith ?? [], groups, `node '${nodeName}'.messagesWith`);

  // Validate that all concrete names exist in the topology
  for (const name of resolvedAcceptsWorkFrom) {
    if (!nodeNames.has(name)) {
      throw new Error(`topology: node '${nodeName}'.acceptsWorkFrom references unknown node '${name}'`);
    }
  }
  for (const name of resolvedMessagesWith) {
    if (!nodeNames.has(name)) {
      throw new Error(`topology: node '${nodeName}'.messagesWith references unknown node '${name}'`);
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

  // escalatesTo (topology input) → supervisor (Habitat field name in the overlay)
  const resolvedEscalatesTo = resolveScalar(escalatesTo, "escalatesTo");
  const resolvedSubmitsWorkTo = resolveScalar(submitsWorkTo, "submitsWorkTo");

  // Validate resolved concrete scalar names exist in the topology
  if (resolvedEscalatesTo !== undefined && !nodeNames.has(resolvedEscalatesTo)) {
    throw new Error(`topology: node '${nodeName}'.escalatesTo references unknown node '${resolvedEscalatesTo}'`);
  }
  if (resolvedSubmitsWorkTo !== undefined && !nodeNames.has(resolvedSubmitsWorkTo)) {
    throw new Error(`topology: node '${nodeName}'.submitsWorkTo references unknown node '${resolvedSubmitsWorkTo}'`);
  }

  /** @type {ResolvedNode} */
  const result = {
    acceptsWorkFrom: resolvedAcceptsWorkFrom,
    messagesWith: resolvedMessagesWith,
    _resolutions: resolutions,
  };
  if (resolvedEscalatesTo !== undefined) result.escalatesTo = resolvedEscalatesTo;
  if (resolvedSubmitsWorkTo !== undefined) result.submitsWorkTo = resolvedSubmitsWorkTo;
  return result;
}
