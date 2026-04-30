// kanban-scan.mjs — pure helper: scan the issue tree from a given root.
//
// Extracted from kanban.mjs so the scan logic can be unit-tested without
// importing the full kanban script (which has top-level side-effects).
//
// The `scanRoot` parameter should be the kanban worktree path — i.e.
// process.cwd() as seen by kanban.mjs, which the launcher spawns with
// cwd: kanbanWorktreePath.  The issues live on the feature branch that is
// checked out in that worktree, not in the project root (which stays on main).

import fs from "node:fs";
import path from "node:path";

/**
 * Parse metadata from an issue file (Status:, Claimed-by:, Depends-on: lines).
 * Returns null if the file cannot be read.
 */
export function parseIssueFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const statusMatch = /^Status:\s*(.+)$/m.exec(content);
  const claimedMatch = /^Claimed-by:\s*(.+)$/m.exec(content);
  const dependsOnMatches = [...content.matchAll(/^Depends-on:\s*(.+)$/mg)];
  return {
    path: filePath,
    status: statusMatch ? statusMatch[1].trim() : "",
    claimedBy: claimedMatch ? claimedMatch[1].trim() : undefined,
    dependsOn: dependsOnMatches.map((m) => m[1].trim()),
  };
}

/**
 * Scan the issue directory for open (non-closed) issue files.
 *
 * @param {string} feature  - feature slug (e.g. "v1-fixture")
 * @param {string} scanRoot - absolute path to scan from; should be the kanban
 *   worktree root (process.cwd() inside kanban.mjs), NOT the project root.
 *   The issue files live under .scratch/<feature>/issues/ relative to this root.
 * @returns {Array} parsed metadata for each valid open issue file.
 */
export function scanIssueTree(feature, scanRoot) {
  const issuesDir = path.join(scanRoot, ".scratch", feature, "issues");
  let entries;
  try {
    entries = fs.readdirSync(issuesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const issues = [];
  for (const e of entries) {
    // Skip subdirectories (e.g. closed/) — only top-level .md files are open issues.
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const filePath = path.join(issuesDir, e.name);
    const meta = parseIssueFile(filePath);
    if (meta) issues.push(meta);
  }
  return issues;
}
