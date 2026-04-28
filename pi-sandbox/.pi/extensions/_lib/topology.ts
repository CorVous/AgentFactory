import { parse as parseYaml } from "yaml";

export interface TopologyNode {
  name: string;
  recipe?: string;
  type?: "relay";
  sandbox?: string;
  task?: string;
  // Habitat-overlay fields (post-3b):
  supervisor?: string;
  submitTo?: string;
  acceptedFrom?: string[];
  peers?: string[];
}

export interface GroupBinding {
  supervisor?: string;
  submitTo?: string;
  acceptedFrom?: string[];
  peers?: string[];
}

export interface Topology {
  bus_root?: string;
  groups?: Record<string, string[]>;
  group_bindings?: Record<string, GroupBinding>;
  nodes: TopologyNode[];
}

export interface ResolvedNode {
  supervisor?: string;
  submitTo?: string;
  acceptedFrom: string[];
  peers: string[];
}

export function parseTopology(yamlText: string): Topology {
  const raw = parseYaml(yamlText) as Record<string, unknown> | null;

  if (!raw || typeof raw !== "object") throw new Error("topology: YAML must be a mapping");
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new Error("topology: 'nodes' must be a non-empty array");
  }

  const nodes: TopologyNode[] = raw.nodes.map((n: unknown, idx: number) => {
    if (!n || typeof n !== "object") throw new Error(`topology: node[${idx}] must be a mapping`);
    const node = n as Record<string, unknown>;
    if (typeof node.name !== "string" || !node.name) {
      throw new Error(`topology: node[${idx}] missing 'name'`);
    }
    return {
      name: node.name,
      ...(typeof node.recipe === "string" ? { recipe: node.recipe } : {}),
      ...(node.type === "relay" ? { type: "relay" as const } : {}),
      ...(typeof node.sandbox === "string" ? { sandbox: node.sandbox } : {}),
      ...(typeof node.task === "string" ? { task: node.task } : {}),
      ...(typeof node.supervisor === "string" ? { supervisor: node.supervisor } : {}),
      ...(typeof node.submitTo === "string" ? { submitTo: node.submitTo } : {}),
      ...(Array.isArray(node.acceptedFrom)
        ? { acceptedFrom: node.acceptedFrom.filter((s: unknown) => typeof s === "string") }
        : {}),
      ...(Array.isArray(node.peers)
        ? { peers: node.peers.filter((s: unknown) => typeof s === "string") }
        : {}),
    };
  });

  // Reject duplicate names
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.name)) throw new Error(`topology: duplicate node name: '${node.name}'`);
    seen.add(node.name);
  }

  const topo: Topology = { nodes };

  if (typeof raw.bus_root === "string") topo.bus_root = raw.bus_root;

  if (raw.groups && typeof raw.groups === "object" && !Array.isArray(raw.groups)) {
    const groups: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(raw.groups as Record<string, unknown>)) {
      if (!Array.isArray(v)) throw new Error(`topology: groups.${k} must be an array`);
      groups[k] = v.filter((s: unknown) => typeof s === "string");
    }
    topo.groups = groups;
  }

  if (
    raw.group_bindings &&
    typeof raw.group_bindings === "object" &&
    !Array.isArray(raw.group_bindings)
  ) {
    const bindings: Record<string, GroupBinding> = {};
    for (const [k, v] of Object.entries(raw.group_bindings as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        throw new Error(`topology: group_bindings.${k} must be a mapping`);
      }
      const b = v as Record<string, unknown>;
      const binding: GroupBinding = {};
      if (typeof b.supervisor === "string") binding.supervisor = b.supervisor;
      if (typeof b.submitTo === "string") binding.submitTo = b.submitTo;
      if (Array.isArray(b.acceptedFrom))
        binding.acceptedFrom = b.acceptedFrom.filter((s: unknown) => typeof s === "string");
      if (Array.isArray(b.peers))
        binding.peers = b.peers.filter((s: unknown) => typeof s === "string");
      bindings[k] = binding;
    }
    topo.group_bindings = bindings;
  }

  return topo;
}

// Expand a list that may contain @<group> references into concrete peer names.
function expandRefs(
  list: string[],
  groups: Record<string, string[]> | undefined,
  context: string,
): string[] {
  const result: string[] = [];
  for (const item of list) {
    if (item.startsWith("@")) {
      const groupName = item.slice(1);
      const members = groups?.[groupName];
      if (!members) throw new Error(`topology: unknown group reference '@${groupName}' in ${context}`);
      result.push(...members);
    } else {
      result.push(item);
    }
  }
  return result;
}

export function resolveNode(topo: Topology, nodeName: string): ResolvedNode {
  const node = topo.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`topology: node '${nodeName}' not found in topology`);

  const nodeNames = new Set(topo.nodes.map((n) => n.name));
  const groups = topo.groups;

  // Collect all groups this node belongs to (order: groups in declaration order)
  const memberGroups: string[] = [];
  if (groups) {
    for (const [groupName, members] of Object.entries(groups)) {
      if (members.includes(nodeName)) memberGroups.push(groupName);
    }
  }

  // Start from an empty base and apply group_bindings in group-declaration order.
  // Later groups in the list overwrite earlier ones for scalar fields; for array
  // fields we also replace (last binding wins). Per-node fields override all bindings.
  let supervisor: string | undefined;
  let submitTo: string | undefined;
  let acceptedFrom: string[] | undefined;
  let peers: string[] | undefined;

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

  const result: ResolvedNode = {
    acceptedFrom: resolvedAcceptedFrom,
    peers: resolvedPeers,
  };
  if (supervisor !== undefined) result.supervisor = supervisor;
  if (submitTo !== undefined) result.submitTo = submitTo;
  return result;
}
