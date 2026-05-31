// habitat-types.ts — shared Habitat interface for the engine package.
//
// This is a faithful copy of the Habitat shape from
// pi-sandbox/.pi/extensions/_lib/habitat.ts. The engine cannot depend on
// pi-sandbox/; the interface is the shared contract per ADR-0010.
//
// Keep this in sync with the canonical definition in pi-sandbox when the
// Habitat struct changes.

import type { InitialMeshEntry, SpawnWiringEntry } from "./resolve-recipe.js";

export interface Habitat {
  // Identity
  instanceName: string;
  description?: string;
  tier?: string;
  recipe?: string;

  // Filesystem
  scratchRoot: string;

  // Bus
  busRoot: string;

  // Recipe metadata exposed for footer rendering
  skills: string[];
  spawns: string[];

  // Verbose diagnostic logging toggle (forwarded by --debug; default false).
  debug: boolean;

  // Slice 4 (ADR-0009): marks this session as the mesh host.
  // True when launched with --is-host; false for all workers.
  isHost: boolean;

  // Slice 4: initial_mesh: entries from the recipe (present only when isHost = true).
  initialMesh?: InitialMeshEntry[];

  // Slice 4: per-spawn wiring from object-form spawns: entries.
  spawnWiring?: SpawnWiringEntry[];

  // Phase 3b: peer relationships
  supervisor?: string;
  submitsWorkTo?: string;
  acceptsWorkFrom: string[];
  messagesWith: string[];

  // Slice 3 (ADR-0008): spawner-scoped group memberships for this peer.
  // Set from --topology-overlay at spawn time; defaults to [] (peer joins
  // @_default implicitly, but rails read this field as declared groups).
  groups: string[];
  /** The spawner's instance name — used for cohort-registry scoping. */
  spawnerName?: string;
}
