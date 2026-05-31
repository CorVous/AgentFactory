/**
 * entry-resolver.d.mts — TypeScript declarations for entry-resolver.mjs
 */

import type { Topology } from "./topology.mjs";

export interface EntryResolveResult {
  entryPeer: string | null;
  topSupervisor: string | null;
  errors: string[];
}

/**
 * Resolve the `entry:` field and top supervisor from a topology.
 * Does not throw — all issues are returned in the result object.
 */
export function resolveEntry(topo: Topology): EntryResolveResult;

/**
 * Returns the name to focus on after an entry-peer crash (the top supervisor).
 * Returns null when the top supervisor can't be resolved uniquely.
 */
export function crashAutoShiftTarget(topo: Topology): string | null;
