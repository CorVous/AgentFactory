// mesh-peering.ts — lazy-acquisition predicate for the mesh subsystem.
//
// The single gate for "should this session bind a bus socket / connect to
// the launcher". A solo pi --recipe run (no peers in the Habitat) should
// not bind any OS resources; a peered recipe should mesh normally.
//
// Used by agent-bus.ts and launcher-bridge.ts to guard their session_start
// resource acquisition. Tool registration stays UNCONDITIONAL so recipe
// allowlists referencing mesh tools always resolve (per ADR-0010).

import type { Habitat } from "./habitat-types.js";

/**
 * Returns true iff the Habitat has any peer relationships configured:
 *   - peers.length > 0
 *   - acceptedFrom.length > 0
 *   - supervisor is a non-empty string
 *   - submitTo is a non-empty string
 *
 * A solo run (all four fields empty/absent) returns false — no bus socket
 * or launcher connection should be opened.
 */
export function habitatHasPeers(h: Habitat): boolean {
  if (Array.isArray(h.peers) && h.peers.length > 0) return true;
  if (Array.isArray(h.acceptedFrom) && h.acceptedFrom.length > 0) return true;
  if (h.supervisor && h.supervisor.trim().length > 0) return true;
  if (h.submitTo && h.submitTo.trim().length > 0) return true;
  return false;
}
