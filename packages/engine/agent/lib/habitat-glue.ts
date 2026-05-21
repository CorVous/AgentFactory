// habitat-glue.ts — thin shim providing setHabitat for the engine package.
//
// The engine cannot depend on pi-sandbox/; this module reimplements the
// minimal setHabitat function so recipe-loader.ts can store the Habitat on
// globalThis where other extensions (sandbox, agent-bus, etc.) read it via
// getHabitat() from their own habitat.ts copies.
//
// The Habitat type is the shared contract (habitat-types.ts).

import type { Habitat } from "./habitat-types.js";

export function setHabitat(h: Habitat): void {
  (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__ = h;
}

export function getHabitat(): Habitat {
  const h = (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__;
  if (!h) {
    throw new Error(
      "getHabitat: Habitat has not been materialised yet; recipe-loader extension must run first",
    );
  }
  return h;
}
