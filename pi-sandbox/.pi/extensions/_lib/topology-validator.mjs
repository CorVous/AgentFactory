/**
 * topology-validator.mjs — validates a parsed topology against the schema rules
 * required by the launcher-multiplexed TUI architecture (ADR-0004).
 *
 * Validation rules:
 *   ERRORS (block launch):
 *   - Explicit `entry:` that doesn't resolve (unknown name, unknown @group, @group with zero members)
 *   - Zero or multiple peers with unset `escalatesTo:` (exactly one top supervisor required)
 *   - Nodes with an unknown `type:` value (the only valid nodes are pi-agent nodes with no `type:` set)
 *   - `@group` references to undefined groups (in per-node and group_binding arrays)
 *   - `acceptsWorkFrom` / `messagesWith` fields referencing node names not in the topology
 *
 *   WARNINGS (emitted to stderr; do not block launch):
 *   - Top supervisor's recipe has `model: TASK_RABBIT_MODEL`
 *
 * The module is a pure function over the parsed topology + optional recipe
 * loader — no live model, no network, no filesystem (except what the
 * caller passes via recipeLoader).
 */

import { aggregateGroupMembership } from "./group-membership.mjs";
import { resolveRef } from "./ref-resolver.mjs";

/**
 * @typedef {{
 *   name: string;
 *   recipe?: string;
 *   type?: string;
 *   escalatesTo?: string;
 *   acceptsWorkFrom?: string[];
 *   messagesWith?: string[];
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
 * Returns the expanded list; pushes to errors when a group is missing or empty.
 *
 * @param {string[]} list
 * @param {Map<string, string[]>} groups
 * @param {string} context
 * @param {string[]} errors
 * @returns {string[]}
 */
function expandRefs(list, groups, context, errors) {
  const result = [];
  for (const item of list) {
    if (item.startsWith("@")) {
      const groupName = item.slice(1);
      const members = groups.get(groupName);
      try {
        const expanded = /** @type {string[]} */ (resolveRef(item, members, "expand-all", undefined));
        result.push(...expanded);
      } catch (e) {
        if (/zero members/.test(e.message)) {
          errors.push(
            `@group reference '@${groupName}' in ${context} resolves to zero members`,
          );
        } else {
          // unknown group
          errors.push(
            `unknown @group reference '@${groupName}' in ${context} — group is not defined`,
          );
        }
      }
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * Validate a scalar field that may be an @<group> ref.
 * Uses a throwaway round-robin counter (just for validation — not for actual assignment).
 * Pushes to errors on unknown/empty group.
 *
 * @param {string | undefined} value
 * @param {Map<string, string[]>} groups
 * @param {string} context  — e.g. "node 'w1'.escalatesTo"
 * @param {string[]} errors
 */
function validateScalarRef(value, groups, context, errors) {
  if (!value || !value.startsWith("@")) return;
  const groupName = value.slice(1);
  const members = groups.get(groupName);
  try {
    resolveRef(value, members, "round-robin", { value: 0 });
  } catch (e) {
    if (/zero members/.test(e.message)) {
      errors.push(
        `@group reference '@${groupName}' in ${context} resolves to zero members`,
      );
    } else {
      errors.push(
        `unknown @group reference '@${groupName}' in ${context} — group is not defined`,
      );
    }
  }
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

  // Build the unified group-membership map (merges top-level groups block + per-node
  // groups: fields). All @group expansions below use this Map so per-node declarations
  // participate in ref resolution.
  const groups = aggregateGroupMembership(topo);

  // ── Rule 1: explicit `entry:` field (optional; missing is allowed) ────────
  // When entry is omitted, the launcher synthesises it from the unique top
  // supervisor (Rule 3 guarantees uniqueness). Only validate when explicitly set.
  if (topo.entry) {
    if (topo.entry.startsWith("@")) {
      // @group ref — reuse validateScalarRef for consistent error messages.
      validateScalarRef(topo.entry, groups, "entry", errors);
    } else if (!nodeNames.has(topo.entry)) {
      errors.push(
        `'entry: ${topo.entry}' does not match any node name in the topology`,
      );
    }
  }

  // ── Rule 2: unknown node type ──────────────────────────────────────────────
  for (const node of topo.nodes) {
    if (node.type !== undefined) {
      errors.push(
        `node '${node.name}' has unknown node type '${node.type}' — ` +
          `the only supported node kind is a pi-agent node (omit the 'type:' field)`,
      );
    }
  }

  // ── Rule 3: exactly one peer with unset escalatesTo: ─────────────────────
  //
  // A node is NOT a top candidate when it has an effective escalatesTo, which
  // includes `escalatesTo: "@group"` that resolves to ≥1 member. An @group ref
  // to an empty group is treated as "unset" here (the empty-group rule in Rule 4
  // will emit a hard error that blocks launch regardless).

  /**
   * Return true when the string value is an @group ref that resolves to ≥1 member.
   * Return false when it's an empty-group ref or a non-@ literal without members.
   * Non-@ literals (concrete names) are always treated as "set".
   * @param {string | undefined} value
   * @returns {boolean}
   */
  function escalatesToIsSet(value) {
    if (value === undefined) return false;
    if (!value.startsWith("@")) return true; // concrete name → always set
    const groupName = value.slice(1);
    const members = groups.get(groupName);
    // Unknown group: emit an error later in Rule 4; treat as "unset" so the
    // top-supervisor check doesn't add a confusing second error.
    if (!members || members.length === 0) return false;
    return true;
  }

  const topCandidates = [];
  for (const node of topo.nodes) {
    if (node.type !== undefined) continue;

    let effectiveEscalatesTo;

    // Group_bindings first (last group wins per topology.mjs semantics).
    // Use the aggregated groups Map so per-node group declarations are included.
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

    // Per-node overrides group_binding
    if (node.escalatesTo !== undefined) {
      effectiveEscalatesTo = node.escalatesTo;
    }

    if (!escalatesToIsSet(effectiveEscalatesTo)) {
      topCandidates.push(node.name);
    }
  }

  if (topCandidates.length === 0) {
    errors.push(
      "every node has a 'escalatesTo:' set — at least one node must be the top supervisor " +
        "(a node with no 'escalatesTo:' field is the top of the escalation chain)",
    );
  } else if (topCandidates.length > 1) {
    errors.push(
      `multiple nodes have no 'escalatesTo:' set (${topCandidates.join(", ")}) — ` +
        `exactly one node must be the top supervisor`,
    );
  }

  // ── Rule 4: @group references must resolve + peer names must exist ─────────
  for (const node of topo.nodes) {
    // Scalar fields: escalatesTo and submitsWorkTo
    if (node.escalatesTo) {
      validateScalarRef(node.escalatesTo, groups, `node '${node.name}'.escalatesTo`, errors);
    }
    if (node.submitsWorkTo) {
      validateScalarRef(node.submitsWorkTo, groups, `node '${node.name}'.submitsWorkTo`, errors);
    }
    if (node.acceptsWorkFrom) {
      const expanded = expandRefs(
        node.acceptsWorkFrom,
        groups,
        `node '${node.name}'.acceptsWorkFrom`,
        errors,
      );
      for (const name of expanded) {
        if (!nodeNames.has(name)) {
          errors.push(
            `node '${node.name}'.acceptsWorkFrom references undeclared peer '${name}'`,
          );
        }
      }
    }
    if (node.messagesWith) {
      const expanded = expandRefs(
        node.messagesWith,
        groups,
        `node '${node.name}'.messagesWith`,
        errors,
      );
      for (const name of expanded) {
        if (!nodeNames.has(name)) {
          errors.push(
            `node '${node.name}'.messagesWith references undeclared peer '${name}'`,
          );
        }
      }
    }
  }

  // Check group_bindings for @group refs to undefined groups (arrays and scalars)
  if (topo.group_bindings) {
    for (const [bindingName, binding] of Object.entries(topo.group_bindings)) {
      if (binding.escalatesTo) {
        validateScalarRef(
          binding.escalatesTo,
          groups,
          `group_bindings.${bindingName}.escalatesTo`,
          errors,
        );
      }
      if (binding.submitsWorkTo) {
        validateScalarRef(
          binding.submitsWorkTo,
          groups,
          `group_bindings.${bindingName}.submitsWorkTo`,
          errors,
        );
      }
      if (binding.acceptsWorkFrom) {
        expandRefs(
          binding.acceptsWorkFrom,
          groups,
          `group_bindings.${bindingName}.acceptsWorkFrom`,
          errors,
        );
      }
      if (binding.messagesWith) {
        expandRefs(
          binding.messagesWith,
          groups,
          `group_bindings.${bindingName}.messagesWith`,
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
