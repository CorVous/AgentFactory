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
