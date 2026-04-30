// Pure helper functions for issue-file authoring used by the thin orchestrator recipe.
// No FS, no model, no network — all functions are safe to test hermetically.

// ---------------------------------------------------------------------------
// Slice A: nextIssueNN
//
// Given a list of existing issue filenames (basenames only, e.g. "01-foo.md"),
// return the next two-digit zero-padded NN string (e.g. "03").
// ---------------------------------------------------------------------------

/**
 * Parse the leading NN from an issue filename like "01-foo.md" or "02-bar.md".
 * Returns NaN if the filename doesn't start with two digits followed by "-".
 */
function parseNN(filename: string): number {
  const m = /^(\d{2})-/.exec(filename);
  return m ? parseInt(m[1], 10) : NaN;
}

/**
 * Given a list of existing issue filenames (basenames), return the next
 * two-digit zero-padded NN. Empty list → "01"; contiguous or non-contiguous
 * numbering → next-after-max.
 */
export function nextIssueNN(filenames: readonly string[]): string {
  const nums = filenames
    .map(parseNN)
    .filter((n) => !isNaN(n));
  const max = nums.length === 0 ? 0 : Math.max(...nums);
  return String(max + 1).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Slice B: titleToSlug
//
// Convert an issue title to a kebab-case slug suitable for the filename.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Slice C: buildIssueBody
//
// Build the canonical issue-file content string.
// Format (per docs/agents/issue-tracker.md):
//   Status: <status>
//   [Depends-on: <dependsOn>]
//
//   # <title>
//
//   <body>
// ---------------------------------------------------------------------------

export interface IssueBodyParams {
  status: "ready-for-agent" | "ready-for-human" | "needs-triage" | "needs-info" | "wontfix";
  title: string;
  dependsOn?: string;
  body: string;
}

/**
 * Build the canonical markdown content for an issue file.
 * The Status: line appears first; Depends-on: is optional and follows immediately.
 * Then a blank line, the title as a heading, a blank line, and the body text.
 */
export function buildIssueBody(params: IssueBodyParams): string {
  const { status, title, dependsOn, body } = params;
  const lines: string[] = [];
  lines.push(`Status: ${status}`);
  if (dependsOn) lines.push(`Depends-on: ${dependsOn}`);
  lines.push("");
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(body.trimEnd());
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Slice D: composeIssueFile
//
// Compose {path, content} for a new issue file, ready to pass to deferred_write.
// ---------------------------------------------------------------------------

export interface ComposeIssueFileParams {
  /** Feature slug — the directory under .scratch/ that contains the issues/. */
  feature: string;
  status: IssueBodyParams["status"];
  title: string;
  dependsOn?: string;
  body: string;
  /**
   * Basenames of files already in .scratch/<feature>/issues/ (not closed/).
   * Used to compute the next NN.
   */
  existingFilenames: readonly string[];
}

export interface IssueFile {
  path: string;
  content: string;
}

/**
 * Compose the path and content for a new issue file.
 * Path: `.scratch/<feature>/issues/<NN>-<slug>.md`
 * Content: canonical issue-file body per buildIssueBody.
 */
export function composeIssueFile(params: ComposeIssueFileParams): IssueFile {
  const { feature, status, title, dependsOn, body, existingFilenames } = params;
  const nn = nextIssueNN(existingFilenames);
  const slug = titleToSlug(title);
  const path = `.scratch/${feature}/issues/${nn}-${slug}.md`;
  const content = buildIssueBody({ status, title, dependsOn, body });
  return { path, content };
}

const SLUG_MAX_LENGTH = 60;

/**
 * Convert a title string to a kebab-case slug.
 * - Lowercases all characters.
 * - Replaces non-alphanumeric runs with a single hyphen.
 * - Trims leading/trailing hyphens.
 * - Truncates to SLUG_MAX_LENGTH characters (at a hyphen boundary when possible).
 */
export function titleToSlug(title: string): string {
  let slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length <= SLUG_MAX_LENGTH) return slug;

  // Truncate at the last hyphen at or before the limit.
  const truncated = slug.slice(0, SLUG_MAX_LENGTH);
  const lastHyphen = truncated.lastIndexOf("-");
  return lastHyphen > 0 ? truncated.slice(0, lastHyphen) : truncated;
}
