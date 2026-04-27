// TS twin of scripts/agent-naming.mjs, sharing the same breed-names.json
// data file. Used by agent-spawn to pre-generate child names so the
// parent populates the delegation box with the unique slug from
// dispatch-time rather than waiting on the first status envelope.
//
// `prettify` is the slug-to-display helper used by agent-header and
// delegation-boxes — kept here so all naming logic lives in one place.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(HERE, "..", "..", "..", "..", "scripts", "breed-names.json");
const DATA = JSON.parse(readFileSync(DATA_PATH, "utf8")) as {
  rabbits: string[];
  hares: string[];
};

export const RABBIT_BREEDS: ReadonlyArray<string> = Object.freeze([...DATA.rabbits]);
export const HARE_BREEDS: ReadonlyArray<string> = Object.freeze([...DATA.hares]);

export interface GenerateOptions {
  tier?: string;
  shortName: string;
  taken?: Set<string>;
}

export function generateInstanceName({ tier, shortName, taken }: GenerateOptions): string {
  if (typeof shortName !== "string" || !shortName) {
    throw new TypeError("generateInstanceName: shortName must be a non-empty string");
  }
  const seen = taken instanceof Set ? taken : new Set<string>();
  const pool = tier === "LEAD_HARE_MODEL" ? HARE_BREEDS : RABBIT_BREEDS;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const breed of shuffled) {
    const slug = `${breed}-${shortName}`;
    if (!seen.has(slug)) return slug;
  }
  const breed = pool[Math.floor(Math.random() * pool.length)];
  for (let n = 2; n < 1000; n++) {
    const slug = `${breed}-${shortName}-${n}`;
    if (!seen.has(slug)) return slug;
  }
  throw new Error(`agent-naming: exhausted suffix space for ${shortName}`);
}

export function prettify(slug: string): string {
  return slug
    .split("-")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}
