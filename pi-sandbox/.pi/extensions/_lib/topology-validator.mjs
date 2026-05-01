/**
 * topology-validator.mjs — validates a parsed topology against the schema rules
 * required by the launcher-multiplexed TUI architecture (ADR-0004).
 *
 * Validation rules:
 *   ERRORS (block launch):
 *   - Missing required `entry:` field at the topology root
 *   - Zero or multiple peers with unset `supervisor:` (exactly one top supervisor required)
 *   - `type: relay` nodes (deprecated; now rejected)
 *   - `@group` references to undefined groups (in per-node and group_binding arrays)
 *   - `acceptedFrom` / `peers` fields referencing node names not in the topology
 *
 *   WARNINGS (emitted to stderr; do not block launch):
 *   - Top supervisor's recipe has `model: TASK_RABBIT_MODEL`
 *
 * The module is a pure function over the parsed topology + optional recipe
 * loader — no live model, no network, no filesystem (except what the
 * caller passes via recipeLoader).
 */

/**
 * @typedef {{
 *   name: string;
 *   recipe?: string;
 *   type?: "relay";
 *   supervisor?: string;
 *   acceptedFrom?: string[];
 *   peers?: string[];
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
 * @typedef {{ errors: string[]; warnings: string[] }} ValidationResult
 */

/**
 * Optional callback to load a recipe file's `model:` field.
 * Returns the model tier string (e.g. "TASK_RABBIT_MODEL") or undefined if
 * the recipe is not found / has no model field.
 *
 * Keeping this as an injectable dependency lets tests stay hermetic (no fs).
 *
 * @typedef {(recipeName: string) => string | undefined} RecipeModelLoader
 */

/**
 * Expand a list that may contain @<group> references into concrete peer names.
 * Returns the expanded list; pushes to errors when a group is missing.
 *
 * @param {string[]} list
 * @param {Record<string, string[]> | undefined} groups
 * @param {string} context
 * @param {string[]} errors
 * @returns {string[]}
 */
function expandRefs(list, groups, context, errors) {
  const result = [];
  for (const item of list) {
    if (item.startsWith("@")) {
      const groupName = item.slice(1);
      const members = groups?.[groupName];
      if (!members) {
        errors.push(
          `unknown @group reference '@${groupName}' in ${context} — group is not defined`,
        );
      } else {
        result.push(...members);
      }
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * Validate a topology and return {errors, warnings}.
 *
 * @param {Topology} topo — parsed topology object
 * @param {RecipeModelLoader | undefined} [recipeModelLoader] — optional; used to check top supervisor's tier
 * @returns {ValidationResult}
 */
export function validateTopology(topo, recipeModelLoader) {
  const errors = [];
  const warnings = [];

  const nodeNames = new Set(topo.nodes.map((n) => n.name));

  // ── Rule 1: required `entry:` field ────────────────────────────────────────
  if (!topo.entry) {
    errors.push(
      "topology is missing required 'entry:' field — add `entry: <peer-name>` at the root",
    );
  } else if (!nodeNames.has(topo.entry)) {
    errors.push(
      `'entry: ${topo.entry}' does not match any node name in the topology`,
    );
  }

  // ── Rule 2: type: relay deprecation ────────────────────────────────────────
  for (const node of topo.nodes) {
    if (node.type === "relay") {
      errors.push(
        `node '${node.name}' uses 'type: relay' which is deprecated and no longer supported — ` +
          `delete the node and replace human interaction with the launcher TUI (see ADR-0004)`,
      );
    }
  }

  // ── Rule 3: exactly one peer with unset supervisor: ────────────────────────
  const topCandidates = [];
  for (const node of topo.nodes) {
    if (node.type === "relay") continue;

    let effectiveSupervisor;

    // Group_bindings first (last group wins per topology.mjs semantics)
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

    // Per-node overrides group_binding
    if (node.supervisor !== undefined) {
      effectiveSupervisor = node.supervisor;
    }

    if (effectiveSupervisor === undefined) {
      topCandidates.push(node.name);
    }
  }

  if (topCandidates.length === 0) {
    errors.push(
      "every node has a 'supervisor:' set — at least one node must be the top supervisor " +
        "(a node with no 'supervisor:' field is the top of the escalation chain)",
    );
  } else if (topCandidates.length > 1) {
    errors.push(
      `multiple nodes have no 'supervisor:' set (${topCandidates.join(", ")}) — ` +
        `exactly one node must be the top supervisor`,
    );
  }

  // ── Rule 4: @group references must resolve + peer names must exist ─────────
  for (const node of topo.nodes) {
    if (node.acceptedFrom) {
      const expanded = expandRefs(
        node.acceptedFrom,
        topo.groups,
        `node '${node.name}'.acceptedFrom`,
        errors,
      );
      for (const name of expanded) {
        if (!nodeNames.has(name)) {
          errors.push(
            `node '${node.name}'.acceptedFrom references undeclared peer '${name}'`,
          );
        }
      }
    }
    if (node.peers) {
      const expanded = expandRefs(
        node.peers,
        topo.groups,
        `node '${node.name}'.peers`,
        errors,
      );
      for (const name of expanded) {
        if (!nodeNames.has(name)) {
          errors.push(
            `node '${node.name}'.peers references undeclared peer '${name}'`,
          );
        }
      }
    }
  }

  // Check group_bindings for @group refs to undefined groups
  if (topo.group_bindings) {
    for (const [bindingName, binding] of Object.entries(topo.group_bindings)) {
      if (binding.acceptedFrom) {
        expandRefs(
          binding.acceptedFrom,
          topo.groups,
          `group_bindings.${bindingName}.acceptedFrom`,
          errors,
        );
      }
      if (binding.peers) {
        expandRefs(
          binding.peers,
          topo.groups,
          `group_bindings.${bindingName}.peers`,
          errors,
        );
      }
    }
  }

  // ── Rule 5 (warning): top supervisor uses TASK_RABBIT_MODEL ────────────────
  if (topCandidates.length === 1 && recipeModelLoader) {
    const topSupervisorName = topCandidates[0];
    const topNode = topo.nodes.find((n) => n.name === topSupervisorName);
    if (topNode?.recipe) {
      const modelTier = recipeModelLoader(topNode.recipe);
      if (modelTier === "TASK_RABBIT_MODEL") {
        warnings.push(
          `WARNING: top supervisor '${topSupervisorName}' resolves to TASK_RABBIT_MODEL — ` +
            `escalation chain will end at a worker-tier LLM`,
        );
      }
    }
  }

  return { errors, warnings };
}
