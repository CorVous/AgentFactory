// load-tier-config.ts — thin I/O loader for the tier resolver.
//
// Two functions:
//   loadBundledDefaults() — reads tier-defaults.json shipped with this package.
//   loadOverrideConfig(filePath?) — reads a user override file; returns {} on
//     missing / malformed (non-fatal, override is optional).
//
// Import-side effects: none. Both functions are called lazily by recipe-loader.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { TIER_VARS } from "./resolve-model.js";

const DEFAULTS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "tier-defaults.json",
);

/** Default path for the user override file. */
export const DEFAULT_OVERRIDE_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "models.json",
);

/**
 * Load the bundled default tier→model-ID map from tier-defaults.json.
 * Ships with the package; always present. Throws only on corrupt package install.
 */
export function loadBundledDefaults(): Record<string, string> {
  const raw = readFileSync(DEFAULTS_PATH, "utf8");
  return JSON.parse(raw) as Record<string, string>;
}

/**
 * Load a user override config from `filePath` (defaults to ~/.pi/agent/models.json).
 * Returns {} if the file is absent or contains malformed JSON (non-fatal).
 * Keys that are not known tier var names are filtered out silently.
 */
export function loadOverrideConfig(
  filePath: string = DEFAULT_OVERRIDE_PATH,
): Record<string, string> {
  if (!existsSync(filePath)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  // Filter to only known tier var names.
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (TIER_VARS.has(key) && typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}
