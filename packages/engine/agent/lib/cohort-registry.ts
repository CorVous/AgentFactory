// cohort-registry.ts — spawner-scoped cohort registry and resolver.
//
// The CohortRegistry is the canonical data structure for tracking group
// membership per spawner namespace. `mesh-mux` (Slice 4) owns the live
// registry; this file provides the pure data structures, mutation helpers,
// and resolver (all unit-testable without a live pi session).
//
// See ADR-0008 for the reference grammar and resolution semantics.

import { resolveRef, type CounterState } from "./ref-resolver.js";

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/** A member of a cohort: known peer name + the recipe it runs. */
export interface CohortMember {
  peer: string;
  recipe: string;
}

/**
 * Per-spawner group map: groupName → list of CohortMember.
 * `"_default"` is the implicit group for peers declared with no groups.
 */
export type GroupMap = Map<string, CohortMember[]>;

/**
 * Top-level registry: spawnerName → its private GroupMap.
 * Two spawners can share group names (e.g. "haiku") without collision.
 */
export type CohortRegistry = Map<string, GroupMap>;

// ---------------------------------------------------------------------------
// A mesh-update change record — mirrors the bus-envelope shape
// ---------------------------------------------------------------------------

export interface MeshUpdateChange {
  peer: string;
  recipe: string;
  groups: string[];
  op: "add" | "remove";
}

export interface MeshUpdate {
  spawner: string;
  changes: MeshUpdateChange[];
}

// ---------------------------------------------------------------------------
// Pure mutation helpers
// ---------------------------------------------------------------------------

/**
 * Add a member to the registry under the given spawner.
 * - If `groups` is empty the peer joins `["_default"]`.
 * - Deduplicates within each group (first-occurrence / insertion order).
 */
export function addMember(
  reg: CohortRegistry,
  spawner: string,
  member: CohortMember,
  groups: string[],
): void {
  if (!reg.has(spawner)) reg.set(spawner, new Map());
  const gm = reg.get(spawner)!;
  const effective = groups.length > 0 ? groups : ["_default"];
  for (const g of effective) {
    if (!gm.has(g)) gm.set(g, []);
    const members = gm.get(g)!;
    if (!members.some((m) => m.peer === member.peer)) {
      members.push({ ...member });
    }
  }
}

/**
 * Remove a peer from all groups within a spawner's namespace.
 * No-op if the spawner or peer is unknown.
 */
export function removeMember(
  reg: CohortRegistry,
  spawner: string,
  peer: string,
): void {
  const gm = reg.get(spawner);
  if (!gm) return;
  for (const [group, members] of gm) {
    const idx = members.findIndex((m) => m.peer === peer);
    if (idx !== -1) members.splice(idx, 1);
    if (members.length === 0) gm.delete(group);
  }
  if (gm.size === 0) reg.delete(spawner);
}

/**
 * Apply a mesh-update's change list to the registry.
 * - `op:"add"` calls `addMember`.
 * - `op:"remove"` calls `removeMember`.
 */
export function applyMeshUpdate(reg: CohortRegistry, update: MeshUpdate): void {
  for (const change of update.changes) {
    if (change.op === "add") {
      addMember(
        reg,
        update.spawner,
        { peer: change.peer, recipe: change.recipe },
        change.groups,
      );
    } else {
      removeMember(reg, update.spawner, change.peer);
    }
  }
}

// ---------------------------------------------------------------------------
// Cohort resolver
// ---------------------------------------------------------------------------

export type FieldKind = "list" | "singular";

export interface ResolveCohortRefOptions {
  /** The @ ref to resolve (e.g. `@haiku`, `@haiku:writer`, `@$myGroups`, …). */
  ref: string;
  registry: CohortRegistry;
  /** Which spawner namespace to scope to. */
  spawnerName: string;
  /**
   * The resolving peer's own group membership (used for `@$myGroups`-flavoured refs).
   * Pass `[]` for ungrouped peers (they implicitly belong to `_default`).
   */
  resolverGroups: string[];
  /** `"list"` → expand-all → string[]; `"singular"` → round-robin → string. */
  fieldKind: FieldKind;
  /** Mutable counter for round-robin singular resolution. */
  counterState?: CounterState;
}

/**
 * ADR-0008 exact error message for empty group at singular resolution time.
 */
function emptyGroupSingularError(peer: string, field: string, ref: string): string {
  return `${peer}: ${field} references empty group \`${ref}\` at spawn time.`;
}

/**
 * Resolve a cohort reference within the given spawner's namespace.
 *
 * Supported ref forms (ADR-0008):
 *   @<group>:<recipe>   — members of <group> running <recipe>
 *   @<group>            — all members of <group>
 *   @$myGroups:<recipe> — members of any of the resolver's own groups running <recipe>
 *   @$myGroups          — all members of any of the resolver's own groups
 *   @<recipe>           — short for @$myGroups:<recipe>  (from ADR §C)
 *   literal             — pass-through (list → [literal], singular → literal)
 *
 * For list fields: returns string[].
 * For singular fields: returns string (via round-robin); throws on empty group.
 */
export function resolveCohortRef(opts: ResolveCohortRefOptions): string | string[] {
  const { ref, registry, spawnerName, resolverGroups, fieldKind, counterState } = opts;
  const gm = registry.get(spawnerName);

  // Literal (non-@) → pass-through
  if (!ref.startsWith("@")) {
    return fieldKind === "list" ? [ref] : ref;
  }

  const body = ref.slice(1); // strip leading @

  // Parse the ref form
  let groupFilter: string[]; // which groups to look in (empty = all groups)
  let groupFilterAll = false; // true when matching all groups
  let recipeFilter: string | undefined;

  if (body === "$myGroups") {
    // @$myGroups — all peers in any of resolver's own groups
    const effectiveGroups = resolverGroups.length > 0 ? resolverGroups : ["_default"];
    groupFilter = effectiveGroups;
    recipeFilter = undefined;
  } else if (body.startsWith("$myGroups:")) {
    // @$myGroups:<recipe>
    const effectiveGroups = resolverGroups.length > 0 ? resolverGroups : ["_default"];
    groupFilter = effectiveGroups;
    recipeFilter = body.slice("$myGroups:".length);
  } else if (body.includes(":")) {
    // @<group>:<recipe>
    const colonIdx = body.indexOf(":");
    groupFilter = [body.slice(0, colonIdx)];
    recipeFilter = body.slice(colonIdx + 1);
  } else {
    // Bare @<token> — could be @<group> or @<recipe> (ADR §C).
    // We treat it as @<group> here; classifyBareRef handles the disambiguation
    // at recipe-parse time. In the runtime resolver we treat it as a group name.
    groupFilter = [body];
    recipeFilter = undefined;
  }
  void groupFilterAll; // unused in this path; always false after refactor

  // Collect matching members from the GroupMap
  const collectMembers = (): CohortMember[] => {
    if (!gm) return [];
    const seen = new Set<string>();
    const result: CohortMember[] = [];

    const groups = groupFilter;

    for (const g of groups) {
      const members = gm.get(g) ?? [];
      for (const m of members) {
        if (recipeFilter !== undefined && m.recipe !== recipeFilter) continue;
        if (!seen.has(m.peer)) {
          seen.add(m.peer);
          result.push(m);
        }
      }
    }
    return result;
  };

  const members = collectMembers();
  const peerNames = members.map((m) => m.peer);

  if (fieldKind === "list") {
    return peerNames;
  }

  // Singular: round-robin via resolveRef (which handles the counter + empty error)
  // We need to rethrow with ADR-0008's exact message for empty group.
  if (peerNames.length === 0) {
    // ADR-0008 says: "<peer>: <field> references empty group `<ref>` at spawn time."
    // Since we don't have peer/field context here, surface a general message.
    throw new Error(
      `resolveCohortRef: singular resolution of '${ref}' in spawner '${spawnerName}' resolved to zero members at spawn time.`,
    );
  }

  return resolveRef(ref, peerNames, "round-robin", counterState);
}
