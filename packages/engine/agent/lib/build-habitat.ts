// build-habitat.ts — pure Habitat builder for the engine package.
//
// Builds a Habitat object from a resolved recipe, cwd, agent name, and
// optional flags / peer field overrides.
//
// Pure: no I/O, no process.env access (callers pass what they need).

import os from "node:os";
import path from "node:path";
import type { Habitat } from "./habitat-types.js";
import type { InitialMeshEntry, SpawnWiringEntry } from "./resolve-recipe.js";

const TIER_VARS = new Set(["RABBIT_SAGE_MODEL", "LEAD_HARE_MODEL", "TASK_RABBIT_MODEL"]);

/** Subset of a resolved recipe that buildHabitat reads. */
export interface RecipeForHabitat {
  model?: string;
  tools?: string[];
  prompt?: string;
  description?: string;
  skills?: string[];
  spawns?: string[];
  /** Slice 4: parsed initial_mesh: block (populated on host recipes). */
  initialMesh?: InitialMeshEntry[];
  /** Slice 4: per-spawn wiring from object-form spawns: entries. */
  spawnWiring?: SpawnWiringEntry[];
}

/** Peer relationship fields — from topology overlay or defaults. */
export interface PeerFields {
  supervisor?: string;
  submitsWorkTo?: string;
  acceptsWorkFrom?: string[];
  messagesWith?: string[];
  /** Slice 3: spawner-scoped group memberships. */
  groups?: string[];
  /** Slice 3: the spawner's instance name. */
  spawnerName?: string;
}

/** Flags that influence Habitat construction. */
export interface HabitatFlags {
  debug?: boolean;
  /** Slice 4 (ADR-0009): true when launched with --is-host. */
  isHost?: boolean;
}

export interface BuildHabitatOptions {
  /** The resolved agent instance name (e.g. "cottontail-writer"). */
  instanceName: string;
  /** Absolute path to the sandbox / working directory. */
  cwd: string;
  /** CLI flags (debug, etc.). */
  flags: HabitatFlags;
  /** Resolved recipe fields (optional — when no recipe is active). */
  recipe?: RecipeForHabitat;
  /** Peer relationship overlay from topology or mesh-spawn. */
  peerFields?: PeerFields;
}

/**
 * Merge a JSON topology-overlay string into existing HabitatOptions fields.
 *
 * Overlay merge semantics:
 *   - supervisor / submitsWorkTo: overrides when the overlay has a non-empty string value.
 *   - acceptsWorkFrom / messagesWith: overrides when the overlay array is non-empty.
 *   - spawns: overrides (even with empty array) when the field is present in the overlay.
 *
 * The overlay JSON uses the new vocabulary keys introduced in Slice 1:
 *   escalatesTo → peerFields.supervisor (topology input field name → Habitat field name)
 *   submitsWorkTo → peerFields.submitsWorkTo
 *   acceptsWorkFrom → peerFields.acceptsWorkFrom
 *   messagesWith → peerFields.messagesWith
 *   spawns → spawns
 *
 * Throws if the JSON is malformed (caller is responsible for error handling).
 *
 * @param opts - Mutable habitat options object to merge into.
 * @param json - Raw JSON string from --topology-overlay.
 * @returns The same opts object (mutated in place) for chaining.
 */
export function mergeTopologyOverlay(
  opts: {
    peerFields?: PeerFields;
    spawns?: string[];
  },
  json: string,
): typeof opts {
  const overlay = JSON.parse(json) as Record<string, unknown>;

  if (!opts.peerFields) {
    opts.peerFields = {};
  }

  // escalatesTo (topology input) → supervisor (Habitat field)
  if (typeof overlay.escalatesTo === "string" && overlay.escalatesTo) {
    opts.peerFields.supervisor = overlay.escalatesTo;
  }
  if (typeof overlay.submitsWorkTo === "string" && overlay.submitsWorkTo) {
    opts.peerFields.submitsWorkTo = overlay.submitsWorkTo;
  }
  if (Array.isArray(overlay.acceptsWorkFrom) && (overlay.acceptsWorkFrom as unknown[]).length > 0) {
    opts.peerFields.acceptsWorkFrom = (overlay.acceptsWorkFrom as unknown[]).filter(
      (s): s is string => typeof s === "string",
    );
  }
  if (Array.isArray(overlay.messagesWith) && (overlay.messagesWith as unknown[]).length > 0) {
    opts.peerFields.messagesWith = (overlay.messagesWith as unknown[]).filter(
      (s): s is string => typeof s === "string",
    );
  }
  if (Array.isArray(overlay.spawns)) {
    opts.spawns = (overlay.spawns as unknown[]).filter(
      (s): s is string => typeof s === "string",
    );
  }

  // Slice 3: groups and spawnerName
  if (Array.isArray(overlay.groups)) {
    opts.peerFields.groups = (overlay.groups as unknown[]).filter(
      (s): s is string => typeof s === "string",
    );
  }
  if (typeof overlay.spawnerName === "string" && overlay.spawnerName) {
    opts.peerFields.spawnerName = overlay.spawnerName;
  }

  return opts;
}

/**
 * Build a Habitat from resolved recipe + cwd + flags.
 *
 * @param opts - See BuildHabitatOptions.
 * @returns A complete, validated Habitat object.
 */
export function buildHabitat(opts: BuildHabitatOptions): Habitat {
  const { instanceName, cwd, flags, recipe, peerFields } = opts;

  const scratchRoot = path.resolve(cwd);
  const busRoot = path.join(os.homedir(), ".pi-agent-bus", path.basename(scratchRoot));
  const debug = flags.debug === true;
  const isHost = flags.isHost === true;

  const skills = recipe?.skills?.filter((s): s is string => typeof s === "string").slice() ?? [];
  const spawns = recipe?.spawns?.filter((a): a is string => typeof a === "string").slice() ?? [];

  // Slice 4: initial_mesh and spawnWiring carried from recipe when present.
  const initialMesh = recipe?.initialMesh?.slice();
  const spawnWiring = recipe?.spawnWiring?.slice();

  const description =
    typeof recipe?.description === "string" && recipe.description.trim()
      ? recipe.description.trim()
      : undefined;

  const modelField = recipe?.model;
  const tier =
    typeof modelField === "string" && TIER_VARS.has(modelField) ? modelField : undefined;

  const supervisor = peerFields?.supervisor;
  const submitsWorkTo = peerFields?.submitsWorkTo;
  const acceptsWorkFrom = peerFields?.acceptsWorkFrom?.slice() ?? [];
  const messagesWith = peerFields?.messagesWith?.slice() ?? [];
  // Slice 3: groups default to [] — ungrouped peers join @_default implicitly
  const groups = peerFields?.groups?.slice() ?? [];
  const spawnerName = peerFields?.spawnerName;

  const habitat: Habitat = {
    instanceName,
    description,
    tier,
    scratchRoot,
    busRoot,
    skills,
    spawns,
    debug,
    isHost,
    supervisor,
    submitsWorkTo,
    acceptsWorkFrom,
    messagesWith,
    groups,
    spawnerName,
  };

  if (initialMesh !== undefined) habitat.initialMesh = initialMesh;
  if (spawnWiring !== undefined) habitat.spawnWiring = spawnWiring;

  return habitat;
}
