// build-habitat.ts — pure Habitat builder for the engine package.
//
// Builds a Habitat object from a resolved recipe, cwd, agent name, and
// optional flags / peer field overrides.
//
// Pure: no I/O, no process.env access (callers pass what they need).

import os from "node:os";
import path from "node:path";
import type { Habitat } from "./habitat-types.js";

const TIER_VARS = new Set(["RABBIT_SAGE_MODEL", "LEAD_HARE_MODEL", "TASK_RABBIT_MODEL"]);

/** Subset of a resolved recipe that buildHabitat reads. */
export interface RecipeForHabitat {
  model?: string;
  tools?: string[];
  prompt?: string;
  description?: string;
  skills?: string[];
  agents?: string[];
}

/** Peer relationship fields — from topology overlay or defaults. */
export interface PeerFields {
  supervisor?: string;
  submitTo?: string;
  acceptedFrom?: string[];
  peers?: string[];
}

/** Flags that influence Habitat construction. */
export interface HabitatFlags {
  debug?: boolean;
}

export interface BuildHabitatOptions {
  /** The resolved agent instance name (e.g. "cottontail-writer"). */
  agentName: string;
  /** Absolute path to the sandbox / working directory. */
  cwd: string;
  /** CLI flags (debug, etc.). */
  flags: HabitatFlags;
  /** Resolved recipe fields (optional — when no recipe is active). */
  recipe?: RecipeForHabitat;
  /** Peer relationship overlay from topology or atomic-delegate. */
  peerFields?: PeerFields;
}

/**
 * Build a Habitat from resolved recipe + cwd + flags.
 *
 * @param opts - See BuildHabitatOptions.
 * @returns A complete, validated Habitat object.
 */
export function buildHabitat(opts: BuildHabitatOptions): Habitat {
  const { agentName, cwd, flags, recipe, peerFields } = opts;

  const scratchRoot = path.resolve(cwd);
  const busRoot = path.join(os.homedir(), ".pi-agent-bus", path.basename(scratchRoot));
  const debug = flags.debug === true;

  const skills = recipe?.skills?.filter((s): s is string => typeof s === "string").slice() ?? [];
  const agents = recipe?.agents?.filter((a): a is string => typeof a === "string").slice() ?? [];

  const description =
    typeof recipe?.description === "string" && recipe.description.trim()
      ? recipe.description.trim()
      : undefined;

  const modelField = recipe?.model;
  const tier =
    typeof modelField === "string" && TIER_VARS.has(modelField) ? modelField : undefined;

  const supervisor = peerFields?.supervisor;
  const submitTo = peerFields?.submitTo;
  const acceptedFrom = peerFields?.acceptedFrom?.slice() ?? [];
  const peers = peerFields?.peers?.slice() ?? [];

  return {
    agentName,
    description,
    tier,
    scratchRoot,
    busRoot,
    skills,
    agents,
    debug,
    supervisor,
    submitTo,
    acceptedFrom,
    peers,
  };
}
