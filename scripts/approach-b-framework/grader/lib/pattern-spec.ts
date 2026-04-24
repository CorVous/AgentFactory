import fs from "node:fs";
import path from "node:path";

export interface PatternSpec {
  name: string;
  components: string[];
  tools: string[];
  mode: "json" | "rpc";
  tier: "TASK_MODEL" | "LEAD_MODEL" | "PLAN_MODEL";
  /** Raw path to the pattern file, for error messages. */
  path: string;
}

const COMPONENT_FILENAMES = new Set([
  "cwd-guard.ts",
  "stage-write.ts",
  "emit-summary.ts",
  "review.ts",
  "run-deferred-writer.ts",
]);

const PATTERN_NAMES = [
  "recon",
  "drafter-with-approval",
  "confined-drafter",
  "scout-then-draft",
  "orchestrator",
] as const;
export type PatternName = (typeof PATTERN_NAMES)[number];

export function isKnownPattern(name: string): name is PatternName {
  return (PATTERN_NAMES as readonly string[]).includes(name);
}

export function patternsDir(repoRoot: string): string {
  return path.join(repoRoot, "pi-sandbox", "skills", "pi-agent-assembler", "patterns");
}

export function loadPatternSpec(repoRoot: string, name: string): PatternSpec {
  const filePath = path.join(patternsDir(repoRoot), `${name}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Pattern file not found at ${filePath}`);
  }
  const src = fs.readFileSync(filePath, "utf8");
  return parsePatternSpec(name, filePath, src);
}

export function parsePatternSpec(name: string, filePath: string, src: string): PatternSpec {
  const components = extractComponents(src);
  const tools = extractTools(src);
  const mode = extractMode(src);
  const tier = extractTier(src);
  if (components.length === 0 && name !== "orchestrator") {
    throw new Error(`Pattern ${name}: could not parse ## Parts list from ${filePath}`);
  }
  if (tools.length === 0) {
    throw new Error(`Pattern ${name}: could not parse --tools allowlist from ${filePath}`);
  }
  return { name, components, tools, mode, tier, path: filePath };
}

/**
 * Extract component filenames from the ## Parts section. Only reads
 * from numbered-list items (lines starting with `N.`) — prose around
 * the list (like recon's "cwd-guard.ts is deliberately not loaded")
 * is not an inclusion signal. Scout-then-draft has phase sub-sections
 * with separate numbered lists; we flatten them into one ordered list.
 */
function extractComponents(src: string): string[] {
  const partsSections = extractAllSections(src, "## Parts");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const body of partsSections) {
    for (const line of body.split("\n")) {
      if (!/^\s*\d+\.\s/.test(line)) continue;
      for (const match of line.matchAll(/`([a-z][a-z0-9-]+\.ts)`/gi)) {
        const file = match[1];
        if (COMPONENT_FILENAMES.has(file) && !seen.has(file)) {
          seen.add(file);
          out.push(file);
        }
      }
    }
  }
  return out;
}

/**
 * Extract --tools allowlist. Accepts either the "## `--tools` allowlist"
 * heading with a fenced code block, or inline backtick-quoted CSV in the
 * ## Parts body. Returns the union of tokens from all such CSVs.
 */
function extractTools(src: string): string[] {
  const tokens = new Set<string>();
  // Fenced code blocks under any "--tools" heading.
  for (const heading of findHeadings(src)) {
    if (!/--tools/i.test(heading.title)) continue;
    for (const fence of extractFencedBlocks(heading.body)) {
      for (const tok of fence.split(/[\s,]+/)) {
        const t = tok.trim().replace(/[`"']/g, "");
        if (t && /^[a-z][a-z0-9_]+$/i.test(t)) tokens.add(t);
      }
    }
  }
  // Inline backtick-quoted CSV in any section (scout-then-draft style).
  const inlineSections = [
    ...extractAllSections(src, "## `--tools` allowlist"),
    ...extractAllSections(src, "## --tools allowlist"),
    ...extractAllSections(src, "## Parts"),
  ];
  for (const body of inlineSections) {
    for (const match of body.matchAll(/`([a-z_][a-z0-9_,]*(?:,[a-z_][a-z0-9_]*)+)`/gi)) {
      for (const tok of match[1].split(",")) {
        const t = tok.trim();
        if (t && /^[a-z][a-z0-9_]+$/i.test(t)) tokens.add(t);
      }
    }
  }
  return Array.from(tokens);
}

function extractMode(src: string): "json" | "rpc" {
  if (/"--mode"\s*,\s*"rpc"/.test(src) || /--mode\s+rpc\b/.test(src)) return "rpc";
  return "json";
}

function extractTier(src: string): "TASK_MODEL" | "LEAD_MODEL" | "PLAN_MODEL" {
  const tierSections = extractAllSections(src, "## Model tier").concat(
    extractAllSections(src, "## Model tiers"),
  );
  const body = tierSections.join("\n");
  if (/\$?LEAD_MODEL/.test(body) && !/\$?TASK_MODEL/.test(body)) return "LEAD_MODEL";
  if (/\$?PLAN_MODEL/.test(body) && !/\$?TASK_MODEL/.test(body)) return "PLAN_MODEL";
  return "TASK_MODEL";
}

interface Heading {
  title: string;
  body: string;
}

function findHeadings(src: string): Heading[] {
  const out: Heading[] = [];
  const lines = src.split("\n");
  let current: Heading | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) out.push(current);
      current = { title: m[1], body: "" };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) out.push(current);
  return out;
}

function extractAllSections(src: string, headingLiteral: string): string[] {
  const target = headingLiteral.replace(/^##\s*/, "").trim().toLowerCase();
  return findHeadings(src)
    .filter((h) => h.title.trim().toLowerCase() === target)
    .map((h) => h.body);
}

function extractFencedBlocks(body: string): string[] {
  const out: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of body.matchAll(re)) out.push(m[1]);
  return out;
}
