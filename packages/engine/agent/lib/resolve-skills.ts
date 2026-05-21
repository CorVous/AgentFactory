// resolve-skills.ts — resolves skill names to absolute skill directory paths.
//
// Pure: no writes to process state. Throws on any validation failure.
//
// Skills are searched in precedence order: skillDirs[0] wins over skillDirs[1], etc.
// Absolute paths are accepted verbatim (existence is still verified).
// Bare names are searched as <dir>/<name>/ subdirectories.

import { existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a list of skill names to absolute skill directory paths.
 *
 * Resolution rules for each skill name:
 *   - If `name` is an absolute path, accept verbatim (must exist and be a directory).
 *   - Otherwise, search `skillDirs` in order: first `<dir>/<name>/` that exists wins.
 *   - Throws `skill '<name>' not found` with the searched dirs on miss.
 *
 * @param names - Skill names (bare) or absolute paths to skill directories.
 * @param skillDirs - Precedence-ordered list of directories to search.
 * @returns Array of absolute skill directory paths in input order.
 * @throws {Error} When any skill cannot be resolved.
 */
export function resolveSkills(names: string[], skillDirs: string[]): string[] {
  const resolved: string[] = [];

  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("resolveSkills: skill name must be a non-empty string");
    }

    // Absolute path — accept verbatim.
    if (path.isAbsolute(name)) {
      if (!existsSync(name)) {
        throw new Error(`resolveSkills: skill path does not exist: ${name}`);
      }
      const stat = statSync(name);
      if (!stat.isDirectory()) {
        throw new Error(`resolveSkills: skill path is not a directory: ${name}`);
      }
      resolved.push(name);
      continue;
    }

    // Bare name — search skillDirs in order.
    let found: string | undefined;
    for (const dir of skillDirs) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        found = candidate;
        break;
      }
    }

    if (found === undefined) {
      const searched = skillDirs.map((d) => path.join(d, name)).join(", ");
      throw new Error(
        `resolveSkills: skill '${name}' not found; searched: ${searched}`,
      );
    }

    resolved.push(found);
  }

  return resolved;
}
