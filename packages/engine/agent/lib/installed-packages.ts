// installed-packages.ts — I/O shim for discovering installed pi-package cluster packages.
//
// This module is intentionally NOT unit-tested: it performs real filesystem I/O.
// The pure resolver (rail-packages.ts) is unit-tested independently.
//
// Discovery strategy: check node_modules for the three known cluster package names.
// These packages declare `"keywords": ["pi-package"]` in their package.json but
// we check by name rather than by keyword scan to keep this fast and deterministic.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KNOWN_CLUSTERS = ["deferred-rails", "containment-rails", "ui-rails"];

/**
 * Return the list of cluster package names that are currently installed
 * (discoverable in node_modules relative to this package).
 *
 * This is an I/O shim — call it once and pass the result to `resolveRailPackages`.
 */
export function discoverInstalledPackages(): string[] {
  // Walk up from this file's directory to find node_modules.
  // In a workspace install, packages are hoisted to the root node_modules.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];

  // Try up to 5 levels up from the current file.
  let dir = here;
  for (let i = 0; i < 5; i++) {
    const nm = path.join(dir, "node_modules");
    if (existsSync(nm)) {
      for (const cluster of KNOWN_CLUSTERS) {
        const pkgPath = path.join(nm, "@agentfactory", cluster, "package.json");
        if (existsSync(pkgPath)) {
          candidates.push(cluster);
        }
      }
      // Found a node_modules; use these results.
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Deduplicate in case multiple node_modules dirs were scanned.
  return [...new Set(candidates)];
}
