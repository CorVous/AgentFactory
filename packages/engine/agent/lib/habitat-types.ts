// habitat-types.ts — shared Habitat interface for the engine package.
//
// This is a faithful copy of the Habitat shape from
// pi-sandbox/.pi/extensions/_lib/habitat.ts. The engine cannot depend on
// pi-sandbox/; the interface is the shared contract per ADR-0010.
//
// Keep this in sync with the canonical definition in pi-sandbox when the
// Habitat struct changes.

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
