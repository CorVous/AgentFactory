// rail-packages.ts — pure rail→cluster resolver.
//
// Maps every known rail extension name to its owning cluster package, then
// resolves a list of rail names against the set of currently-installed cluster
// packages.
//
// The resolver is pure (no I/O): `installedPackages` is injected by the
// caller (see installed-packages.ts for the production I/O shim).
//
// Rails mapped to "engine" are always considered resolved — they ship with the
// engine package and are never separately installable.

/** Cluster package name or the marker "engine" for engine-owned rails. */
export type ClusterName =
  | "deferred-rails"
  | "containment-rails"
  | "ui-rails"
  | "engine";

/** Static map: rail extension name → owning cluster. */
export const RAIL_TO_CLUSTER: Record<string, ClusterName> = {
  // deferred-rails cluster
  "deferred-confirm": "deferred-rails",
  "deferred-write": "deferred-rails",
  "deferred-edit": "deferred-rails",
  "deferred-move": "deferred-rails",
  "deferred-delete": "deferred-rails",

  // containment-rails cluster
  "sandbox": "containment-rails",
  "no-edit": "containment-rails",

  // ui-rails cluster
  "agent-header": "ui-rails",
  "agent-footer": "ui-rails",
  "no-startup-help": "ui-rails",
  "hide-extensions-list": "ui-rails",

  // engine-owned rails (always available, never separately installed)
  "peer-bus": "engine",
  "supervisor": "engine",
  "intercept": "engine",
  "atomic-delegate": "engine",
  "habitat": "engine",
  "launcher-bridge": "engine",
  "slash-commands": "engine",
  "bus-tail-emitter": "engine",
  "mesh-rail": "engine",
  "mesh-spawn": "engine",
  "mesh-mux": "engine",
  "deferred-confirm-baseline": "engine",
};

export interface ResolvedRail {
  rail: string;
  cluster: ClusterName;
}

export interface MissingRail {
  rail: string;
  cluster: string;
  hint: string;
}

export interface ResolveResult {
  resolved: ResolvedRail[];
  missing: MissingRail[];
}

/**
 * Resolve a list of rail names against the installed cluster packages.
 *
 * @param railNames         Rail extension names to resolve (e.g. from recipe.extensions).
 * @param installedPackages Names of currently-installed cluster packages (I/O-free injection).
 * @returns `resolved` contains every rail with its cluster; `missing` contains
 *          only non-engine rails whose cluster package is absent.
 * @throws  When a rail name is not in RAIL_TO_CLUSTER (unknown rail).
 */
export function resolveRailPackages(
  railNames: string[],
  installedPackages: string[],
): ResolveResult {
  const installed = new Set(installedPackages);
  const resolved: ResolvedRail[] = [];
  const missing: MissingRail[] = [];

  for (const rail of railNames) {
    const cluster = RAIL_TO_CLUSTER[rail];
    if (cluster === undefined) {
      throw new Error(
        `rail-packages: unknown rail '${rail}'. ` +
          `Add it to RAIL_TO_CLUSTER or remove it from the recipe's extensions list.`,
      );
    }

    resolved.push({ rail, cluster });

    // Engine-owned rails never need a separate install.
    if (cluster === "engine") continue;

    if (!installed.has(cluster)) {
      missing.push({
        rail,
        cluster,
        hint: `pi install npm:@agentfactory/${cluster}`,
      });
    }
  }

  return { resolved, missing };
}
