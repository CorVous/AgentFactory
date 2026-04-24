import fs from "node:fs";
import path from "node:path";
import {
  isKnownPattern,
  loadPatternSpec,
  patternsDir,
  type PatternName,
} from "../approach-b-framework/grader/lib/pattern-spec.ts";
import { GAP_SEEDS, type GapSeed } from "./gap-seeds.ts";

export type CurationKind = "assembly" | "gap";

export interface Curation {
  kind: CurationKind;
  pattern: PatternName | "gap";
  /** Short English sketch the LLM paraphrases into a user request. */
  phrasingSeed: string;
  /** Components the grader expects to find in the produced artifact. Empty for gap. */
  components: string[];
  /** Pattern-specific probe for the behavioral smoke. Omitted for gap. */
  probe?: { args: string; evidence_anchor?: string };
  /** Slug used as the task directory name under tasks/generated/. */
  tag: string;
  /** For gap curations: the pattern the assembler is *closest* to. */
  closestMatch?: string;
  /** Extra tokens the grader tolerates beyond the pattern baseline. */
  extraTools?: string[];
  extraComponents?: string[];
}

export interface EnumerateOptions {
  /** Restrict to one pattern name (or "gap"). */
  pattern?: PatternName | "gap";
  /** Cap seeds per pattern; default is all extracted from the pattern file. */
  maxSeedsPerPattern?: number;
}

const PATTERN_NAMES: PatternName[] = [
  "recon",
  "drafter-with-approval",
  "confined-drafter",
  "scout-then-draft",
  "orchestrator",
];

/**
 * Default probe per pattern. Matches what the committed hand-authored
 * tasks under scripts/approach-b-framework/tasks/ use, so generated
 * curations exercise the same smoke paths.
 */
const PROBE_DEFAULTS: Record<PatternName, { args: string; evidence_anchor?: string } | undefined> = {
  recon: { args: " skills/pi-agent-builder", evidence_anchor: "SKILL.md" },
  "drafter-with-approval": { args: " create a file hello-probe.md with the text hi" },
  "confined-drafter": { args: " create a tiny hello.ts file that logs hi" },
  "scout-then-draft": { args: " skills/pi-agent-builder" },
  orchestrator: { args: " draft two tiny files: greet.md saying hi and bye.md saying bye" },
};

export function enumerateCurations(repoRoot: string, opts: EnumerateOptions = {}): Curation[] {
  const out: Curation[] = [];

  const patternsToRun: Array<PatternName | "gap"> = opts.pattern
    ? [opts.pattern]
    : [...PATTERN_NAMES, "gap"];

  for (const pat of patternsToRun) {
    if (pat === "gap") {
      out.push(...enumerateGapCurations(GAP_SEEDS));
      continue;
    }
    const spec = loadPatternSpec(repoRoot, pat);
    const seeds = extractShortPromptSignals(repoRoot, pat);
    const limit = opts.maxSeedsPerPattern ?? seeds.length;
    const picked = seeds.slice(0, limit);
    picked.forEach((seed, i) => {
      out.push({
        kind: "assembly",
        pattern: pat,
        phrasingSeed: seed,
        components: spec.components,
        probe: PROBE_DEFAULTS[pat],
        tag: `${pat}-${slugify(seed)}-${pad2(i + 1)}`,
      });
    });
  }
  return out;
}

function enumerateGapCurations(seeds: GapSeed[]): Curation[] {
  return seeds.map((seed, i) => ({
    kind: "gap" as const,
    pattern: "gap" as const,
    phrasingSeed: seed.seed,
    components: [],
    tag: `gap-${slugify(seed.seed)}-${pad2(i + 1)}`,
    closestMatch: seed.closestMatch,
  }));
}

/**
 * Read `## Short-prompt signals that match` from a pattern file and
 * return one seed per bullet. Bullets wrapped in quotes get unquoted;
 * the seed is the raw text the LLM will paraphrase.
 */
function extractShortPromptSignals(repoRoot: string, name: PatternName): string[] {
  const file = path.join(patternsDir(repoRoot), `${name}.md`);
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Short-prompt signals that match\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;
    // Match leading-dash bullets; allow multiple quoted fragments per bullet.
    const m = /^\s*-\s+(.+)$/.exec(line);
    if (!m) continue;
    const body = m[1].trim();
    // Split bullets like `"foo", "bar", "baz"` into separate seeds.
    const quoted = Array.from(body.matchAll(/`([^`]+)`|"([^"]+)"/g));
    if (quoted.length >= 2 && quoted.every((q) => (q[1] ?? q[2]).trim().length > 0)) {
      for (const q of quoted) out.push((q[1] ?? q[2]).trim());
    } else {
      // Unwrap a single outer pair of quotes/backticks if present.
      const unwrapped = body.replace(/^["`](.+)["`]$/, "$1").trim();
      if (unwrapped) out.push(unwrapped);
    }
  }
  return dedupe(out);
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function isPatternOrGap(s: string): s is PatternName | "gap" {
  return s === "gap" || isKnownPattern(s);
}
