// habitat.ts — compatibility re-export for the engine's habitat modules.
//
// Tests and shared libs that import from "./habitat" (matching the
// pi-sandbox/_lib/habitat.ts import path) get both the Habitat type
// and the setHabitat/getHabitat functions from a single entry point.
//
// The canonical implementations live in habitat-glue.ts (functions)
// and habitat-types.ts (type). This shim avoids modifying copied test
// files to use the split paths.

export type { Habitat } from "./habitat-types.js";
export { setHabitat, getHabitat } from "./habitat-glue.js";
