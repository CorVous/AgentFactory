// visibility.ts — ADR-0008 visibility predicate.
//
// X can see Y iff any of:
//   - X is the spawner of Y, OR
//   - Y is the spawner of X, OR
//   - X and Y share a spawner AND share at least one group within that
//     spawner's namespace (including @_default for ungrouped peers).
//
// Pure, hermetic — no I/O.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal description of a peer for visibility calculations. */
export interface PeerNode {
  /** The peer's instance name on the bus. */
  name: string;
  /** The peer that spawned this one (if known). */
  spawner?: string;
  /**
   * Declared group memberships. Empty means the peer belongs to @_default
   * implicitly; this function treats [] as ["_default"] for intersection.
   */
  groups: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Effective groups — [] becomes ["_default"]. */
export function effectiveGroups(groups: string[]): string[] {
  return groups.length > 0 ? groups : ["_default"];
}

/** True if sets share at least one element. */
function setsOverlap(a: string[], b: string[]): boolean {
  const setB = new Set(b);
  return a.some((x) => setB.has(x));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether peer X can see peer Y according to ADR-0008.
 *
 * The spawner↔child structural edge is always visible regardless of groups.
 * Two ungrouped peers sharing a spawner are visible via @_default.
 */
export function canSee(x: PeerNode, y: PeerNode): boolean {
  // Structural edge: X spawned Y
  if (x.name === y.spawner) return true;
  // Structural edge: Y spawned X
  if (y.name === x.spawner) return true;
  // Same-spawner + shared-group check
  if (
    x.spawner !== undefined &&
    y.spawner !== undefined &&
    x.spawner === y.spawner &&
    setsOverlap(effectiveGroups(x.groups), effectiveGroups(y.groups))
  ) {
    return true;
  }
  return false;
}

/**
 * Return the subset of `all` that `self` can see (excludes self from the result).
 */
export function visiblePeers(self: PeerNode, all: PeerNode[]): PeerNode[] {
  return all.filter((p) => p.name !== self.name && canSee(self, p));
}
