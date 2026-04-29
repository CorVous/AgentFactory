/**
 * Pure helpers for assembling issue-tracker markdown files.
 *
 * These functions are intentionally side-effect-free so they can be exercised
 * in hermetic unit tests (no filesystem, no model, no network). The
 * `ralph/orchestrator-thin` recipe instructs the model to follow the same
 * canonical shape these helpers produce.
 */

/**
 * Given a list of existing issue file basenames (or relative paths), return
 * the next two-digit zero-padded issue number as a string (e.g. `"03"`).
 *
 * The function extracts the leading numeric prefix from each name:
 *   `"01-some-issue.md"` → 1
 *   `"closed/07-old-thing.md"` → 7
 *
 * If no existing paths are provided (or none have a parseable prefix), the
 * function returns `"01"`.
 */
export function nextIssueNumber(existingPaths: readonly string[]): string {
  let max = 0;
  for (const p of existingPaths) {
    const basename = p.split(/[/\\]/).pop() ?? "";
    const m = basename.match(/^(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  const next = max + 1;
  return String(next).padStart(2, "0");
}

/**
 * Convert a human-readable title into a kebab-case slug.
 *
 * Rules:
 *   - Lowercase everything.
 *   - Replace runs of non-alphanumeric characters with a single hyphen.
 *   - Strip leading and trailing hyphens.
 *
 * Examples:
 *   "Add retry logic"  → "add-retry-logic"
 *   "Fix: edge-case!"  → "fix-edge-case"
 *   "  Spaces  "       → "spaces"
 */
export function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Options for `formatIssueFile`.
 */
export interface IssueFileOptions {
  /** Triage status — `"ready-for-agent"` or `"ready-for-human"`. */
  status: "ready-for-agent" | "ready-for-human";
  /** Issue title (rendered as the `# Heading`). */
  title: string;
  /** Body text placed under `## What to build`. */
  body: string;
  /**
   * Optional parent PRD path (e.g. `"../PRD.md"`).
   * If omitted the section renders as `"(no PRD)"`.
   */
  prdPath?: string;
  /**
   * Optional `Depends-on:` value — a single path or a comma-separated list.
   * If omitted, the line is not included in the preamble.
   */
  dependsOn?: string;
}

/**
 * Produce the canonical markdown content for a new issue file.
 *
 * Output structure:
 * ```
 * Status: <status>
 * [Depends-on: <dependsOn>]
 *
 * # <title>
 *
 * ## Parent
 *
 * <prdPath or "(no PRD)">
 *
 * ## What to build
 *
 * <body>
 *
 * ## Comments
 * ```
 *
 * The blank line between the preamble block and the `#` heading is always
 * present so issue-tracker tooling can reliably locate the heading.
 */
export function formatIssueFile(opts: IssueFileOptions): string {
  const { status, title, body, prdPath, dependsOn } = opts;

  const preambleLines: string[] = [`Status: ${status}`];
  if (dependsOn) preambleLines.push(`Depends-on: ${dependsOn}`);

  const parentRef = prdPath ?? "(no PRD)";

  return [
    preambleLines.join("\n"),
    "",
    `# ${title}`,
    "",
    "## Parent",
    "",
    parentRef,
    "",
    "## What to build",
    "",
    body.trim(),
    "",
    "## Comments",
    "",
  ].join("\n");
}

/**
 * Convenience wrapper: build the full relative destination path for a new
 * issue file given the feature slug and already-computed NN + slug.
 *
 * Example:
 *   issueFilePath("v1-ralph-loop-mesh", "03", "add-retry-logic")
 *   → ".scratch/v1-ralph-loop-mesh/issues/03-add-retry-logic.md"
 */
export function issueFilePath(featureSlug: string, nn: string, issueSlug: string): string {
  return `.scratch/${featureSlug}/issues/${nn}-${issueSlug}.md`;
}
