// cohort-tracker.ts — pure cohort cache functions consumed by peer-bus.ts.
//
// The cohort tracker folds incoming mesh-update envelopes into a local
// GroupMap cache and provides group-ref expansion for sender-side fan-out.
//
// This module is purely functional (no side effects, no I/O) so it is
// fully unit-testable without a live pi session.
//
// The `__pi_cohort_lookup__` hook interface mirrors the
// `__pi_mesh_spawn_is_my_worker__` pattern — a globalThis-resident hook
// that the host (mesh-mux, Slice 4) installs at runtime. The no-op default
// ensures that Slice 3 code paths compile and pass tests even before the
// host exists.

import type { GroupMap } from "./cohort-registry.js";
import type { MeshUpdateChange } from "./bus-envelope.js";

// ---------------------------------------------------------------------------
// __pi_cohort_lookup__ hook interface
// ---------------------------------------------------------------------------

/**
 * Async hook installed by the host (mesh-mux, Slice 4) to resolve unknown
 * senders against the authoritative registry. Returns the peer's groups
 * and recipe if known, or null if the peer is unknown to the host.
 *
 * Slice 3 lands only the seam: the interface definition + no-op default.
 * The real synchronous host round-trip is Slice 4.
 */
export type CohortLookupHook = (
  peerName: string,
) => Promise<{ groups: string[]; recipe: string } | null>;

/** No-op default resolver — always returns null (peer unknown to host). */
export const defaultCohortLookupHook: CohortLookupHook = async (_name) => null;

/**
 * Install the lookup hook on globalThis. Idempotent: a second install
 * (e.g. by a re-loaded extension) replaces the previous hook.
 */
export function installCohortLookupHook(hook: CohortLookupHook): void {
  (globalThis as { __pi_cohort_lookup__?: CohortLookupHook }).__pi_cohort_lookup__ = hook;
}

/**
 * Get the currently installed hook, falling back to the no-op default.
 */
export function getCohortLookupHook(): CohortLookupHook {
  const g = globalThis as { __pi_cohort_lookup__?: CohortLookupHook };
  return g.__pi_cohort_lookup__ ?? defaultCohortLookupHook;
}

// ---------------------------------------------------------------------------
// Cache mutation
// ---------------------------------------------------------------------------

/**
 * Fold a mesh-update's changes into the local GroupMap cache.
 *
 * An "add" change upserts the peer into each of its declared groups.
 * A "remove" change removes the peer from all groups.
 *
 * The cache is keyed by groupName → string[] (peer names only, for
 * simplicity; the full CohortMember shape is in cohort-registry.ts).
 */
export function ingestMeshUpdate(
  cache: GroupMap,
  update: { spawner: string; changes: MeshUpdateChange[] },
): void {
  for (const change of update.changes) {
    if (change.op === "add") {
      const effectiveGroups = change.groups.length > 0 ? change.groups : ["_default"];
      for (const g of effectiveGroups) {
        if (!cache.has(g)) cache.set(g, []);
        const members = cache.get(g)!;
        // Keep the CohortMember shape for compatibility with GroupMap type
        if (!members.some((m) => m.peer === change.peer)) {
          members.push({ peer: change.peer, recipe: change.recipe });
        }
      }
    } else {
      // Remove peer from all groups
      for (const [group, members] of cache) {
        const idx = members.findIndex((m) => m.peer === change.peer);
        if (idx !== -1) members.splice(idx, 1);
        if (members.length === 0) cache.delete(group);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Group-ref expansion
// ---------------------------------------------------------------------------

/**
 * Expand a group reference against the local cache.
 *
 * Handles:
 *   @<group>           → all peers in <group>
 *   @<group>:<recipe>  → peers in <group> running <recipe>
 *   @$myGroups         → all peers in any of selfGroups (or _default if [])
 *   @$myGroups:<recipe>→ recipe-filtered variant
 *   @<recipe>          → treated as @$myGroups:<recipe> (ADR §C runtime form)
 *   literal            → [literal]
 *
 * Returns [] for empty or unknown groups (never throws for list-field expansion).
 */
export function expandGroupRef(
  cache: GroupMap,
  selfGroups: string[],
  ref: string,
): string[] {
  if (!ref.startsWith("@")) return [ref];

  const body = ref.slice(1);
  const colonIdx = body.indexOf(":");

  let groupKeys: string[];
  let recipeFilter: string | undefined;

  if (body === "$myGroups") {
    groupKeys = selfGroups.length > 0 ? selfGroups : ["_default"];
    recipeFilter = undefined;
  } else if (body.startsWith("$myGroups:")) {
    groupKeys = selfGroups.length > 0 ? selfGroups : ["_default"];
    recipeFilter = body.slice("$myGroups:".length);
  } else if (colonIdx !== -1) {
    groupKeys = [body.slice(0, colonIdx)];
    recipeFilter = body.slice(colonIdx + 1);
  } else {
    // Bare @<token> — could be a group or recipe; treat as group first,
    // then fall back to recipe-in-myGroups if not found.
    // For sender-side fan-out we just do group lookup (runtime simplification).
    groupKeys = [body];
    recipeFilter = undefined;
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const g of groupKeys) {
    const members = cache.get(g) ?? [];
    for (const m of members) {
      if (recipeFilter !== undefined && m.recipe !== recipeFilter) continue;
      if (!seen.has(m.peer)) {
        seen.add(m.peer);
        result.push(m.peer);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Peer lookup helpers
// ---------------------------------------------------------------------------

/**
 * Return the CohortMember for a known peer, or undefined if not cached.
 */
export function lookupKnownPeer(
  cache: GroupMap,
  name: string,
): { peer: string; recipe: string } | undefined {
  for (const members of cache.values()) {
    const m = members.find((x) => x.peer === name);
    if (m) return m;
  }
  return undefined;
}

/**
 * True if the sender is not present in any group in the local cache,
 * meaning the host should be consulted (race window for a newly-spawned peer).
 */
export function needsLookup(cache: GroupMap, senderName: string): boolean {
  return lookupKnownPeer(cache, senderName) === undefined;
}
