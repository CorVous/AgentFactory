export interface Habitat {
  // Identity
  agentName: string;
  description?: string;
  tier?: string;
  type?: string;

  // Filesystem
  scratchRoot: string;

  // Bus
  busRoot: string;

  // Recipe metadata exposed for footer rendering
  skills: string[];
  agents: string[];

  // Verbose diagnostic logging toggle (forwarded by --debug; default false).
  debug: boolean;

  // Slice 4 (ADR-0009): marks this session as the mesh host.
  isHost: boolean;
  /** Slice 4: initial_mesh: entries from the recipe (present only when isHost = true). */
  initialMesh?: Array<{ recipe: string; name?: string; groups?: string[]; task?: string; [key: string]: unknown }>;
  /** Slice 4: per-spawn wiring from object-form spawns: entries. */
  spawnWiring?: Array<{ recipe: string; escalatesTo?: string; submitsWorkTo?: string; acceptsWorkFrom?: string[]; messagesWith?: string[] }>;

  // Phase 3b: peer relationships
  supervisor?: string;
  submitTo?: string;
  acceptedFrom: string[];
  peers: string[];
}

export function setHabitat(h: Habitat): void {
  (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__ = h;
}

export function getHabitat(): Habitat {
  const h = (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__;
  if (!h) throw new Error("getHabitat: Habitat has not been materialised yet; habitat.ts extension must load first");
  return h;
}
