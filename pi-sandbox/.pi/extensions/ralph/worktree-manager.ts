// Per-issue Worktree manager — pure-function core + git operations.
// Used by the Foreman recipe to manage per-issue git worktree lifecycle.
//
// Pure-function core (no git I/O): decideBranchName, decidePath, decideMode
// Git operations: prepareWorktree, disposeWorktree, reintegrate, abortAndCleanup
//
// References: PRD §"Per-issue Worktree manager", ADR-0001, ADR-0005.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse the NN (two-digit issue number) from an issue file path.
 * e.g. ".scratch/feat/issues/03-foo.md" → "03"
 * Returns "" if not parseable.
 */
export function parseIssueNN(issuePath: string): string {
  const basename = path.basename(issuePath);
  const m = /^(\d{2})-/.exec(basename);
  return m ? m[1] : "";
}

/**
 * Parse the slug (everything after the NN- prefix) from an issue file path.
 * e.g. ".scratch/feat/issues/03-afk-trunk-end-to-end.md" → "afk-trunk-end-to-end"
 * Returns "" if not parseable.
 */
export function parseIssueSlug(issuePath: string): string {
  const basename = path.basename(issuePath, ".md");
  const m = /^\d{2}-(.+)$/.exec(basename);
  return m ? m[1] : "";
}

/**
 * Derive the feature slug from a mesh branch name.
 * e.g. "feature/v1-ralph-loop-mesh" → "v1-ralph-loop-mesh"
 */
export function featureSlugFromBranch(meshBranch: string): string {
  return meshBranch.replace(/^feature\//, "");
}

/**
 * Build the per-issue branch name.
 * e.g. meshBranch="feature/v1-ralph-loop-mesh", NN="03", slug="afk-trunk-end-to-end"
 *   → "feature/v1-ralph-loop-mesh-03-afk-trunk-end-to-end"
 */
export function decideBranchName(issuePath: string, meshBranch: string): string {
  const nn = parseIssueNN(issuePath);
  const slug = parseIssueSlug(issuePath);
  return `${meshBranch}-${nn}-${slug}`;
}

/**
 * Build the per-issue worktree path.
 * e.g. projectPath="/tmp/proj", meshBranch="feature/v1-ralph-loop-mesh", NN="03", slug="afk-trunk-end-to-end"
 *   → "/tmp/proj/.mesh-features/v1-ralph-loop-mesh/foreman-03-afk-trunk-end-to-end"
 */
export function decidePath(
  issuePath: string,
  projectPath: string,
  meshBranch: string,
): string {
  const featureSlug = featureSlugFromBranch(meshBranch);
  const nn = parseIssueNN(issuePath);
  const slug = parseIssueSlug(issuePath);
  return path.join(
    projectPath,
    ".mesh-features",
    featureSlug,
    `foreman-${nn}-${slug}`,
  );
}

export type WorktreeMode = "auto-merge" | "branch-emit";

/**
 * Read the Status: line from an issue file and return the reintegration mode.
 * "ready-for-agent" → "auto-merge"
 * "ready-for-human" → "branch-emit"
 * Throws if the file can't be read or the status isn't workable.
 */
export function decideMode(issuePath: string, projectPath: string): WorktreeMode {
  const fullPath = path.isAbsolute(issuePath)
    ? issuePath
    : path.join(projectPath, issuePath);
  const content = readFileSync(fullPath, "utf8");
  const m = /^Status:\s*(.+)$/m.exec(content);
  if (!m) throw new Error(`No Status: line found in ${issuePath}`);
  const status = m[1].trim();
  if (status === "ready-for-agent") return "auto-merge";
  if (status === "ready-for-human") return "branch-emit";
  throw new Error(`Issue ${issuePath} has non-workable status: ${status}`);
}

// ---------------------------------------------------------------------------
// Git helpers (thin wrappers around execFileSync)
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string, extra?: { input?: string }): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input: extra?.input,
    stdio: extra?.input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WorktreeResult {
  worktreePath: string;
  branchName: string;
  mode: WorktreeMode;
}

/**
 * Create a per-issue git worktree on a new branch off `meshBranch`.
 * Returns the worktree path, the new branch name, and the reintegration mode.
 *
 * @param issuePath - Relative path to the issue file (from projectPath), or absolute.
 * @param projectPath - Absolute path to the project root (where .git lives).
 * @param meshBranch - The mesh feature branch (e.g. "feature/v1-ralph-loop-mesh").
 */
export function prepareWorktree(
  issuePath: string,
  projectPath: string,
  meshBranch: string,
): WorktreeResult {
  const worktreePath = decidePath(issuePath, projectPath, meshBranch);
  const branchName = decideBranchName(issuePath, meshBranch);
  const mode = decideMode(issuePath, projectPath);

  mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Create the worktree on a new branch off meshBranch.
  git(["worktree", "add", "-b", branchName, worktreePath, meshBranch], projectPath);

  return { worktreePath, branchName, mode };
}

/**
 * Remove a per-issue git worktree.
 * Tries `git worktree remove` first; falls back to `--force` only if needed.
 */
export function disposeWorktree(worktreePath: string): void {
  // Find the project root by walking up from the worktree.
  // We identify it by the presence of a .git directory (file or dir).
  const projectPath = findProjectRoot(worktreePath);

  try {
    git(["worktree", "remove", worktreePath], projectPath);
  } catch {
    // Fall back to force-remove (e.g. worktree has untracked files)
    git(["worktree", "remove", "--force", worktreePath], projectPath);
  }
}

/**
 * Reintegrate a per-issue branch back into the mesh branch.
 *
 * mode === "auto-merge":
 *   From the kanban worktree, `git merge --ff-only <branchName>` into meshBranch.
 *   Falls back to a regular merge commit if ff-only fails.
 *   Returns {mergedCommit: sha}.
 *
 * mode === "branch-emit":
 *   No-op; returns {}. The HITL emit happens in the Foreman (#04).
 *
 * @param worktreePath - The per-issue worktree (used to derive projectPath and branchName).
 * @param mode - Reintegration mode.
 * @param meshBranch - The target mesh feature branch.
 * @param kanbanWorktreePath - Absolute path to the kanban worktree (merge runs from here).
 */
export interface ReintegrateResult {
  mergedCommit?: string;
}

export function reintegrate(
  worktreePath: string,
  mode: WorktreeMode,
  meshBranch: string,
  kanbanWorktreePath: string,
): ReintegrateResult {
  if (mode === "branch-emit") {
    return {};
  }

  // Determine the per-issue branch name from the worktree list.
  const projectPath = findProjectRoot(worktreePath);
  const branchName = getBranchForWorktree(worktreePath, projectPath);

  // Ensure kanban worktree is on the mesh branch.
  const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], kanbanWorktreePath);
  if (currentBranch !== meshBranch) {
    throw new Error(
      `kanban worktree is on branch '${currentBranch}', expected '${meshBranch}'`,
    );
  }

  // Try ff-only first; fall back to merge commit.
  try {
    git(["merge", "--ff-only", branchName], kanbanWorktreePath);
  } catch {
    git(["merge", "--no-ff", "-m", `Merge ${branchName} into ${meshBranch}`, branchName], kanbanWorktreePath);
  }

  const mergedCommit = git(["rev-parse", "HEAD"], kanbanWorktreePath);
  return { mergedCommit };
}

/**
 * Abort and clean up a failed Foreman run (story #15):
 * - `disposeWorktree` to remove the worktree
 * - `git branch -D <branchName>` to delete the per-issue branch ref
 *
 * Caller should have already removed the Claimed-by: line from the issue file
 * before calling this.
 */
export function abortAndCleanup(worktreePath: string, branchName: string): void {
  const projectPath = findProjectRoot(worktreePath);
  disposeWorktree(worktreePath);
  git(["branch", "-D", branchName], projectPath);
}

// ---------------------------------------------------------------------------
// Private utilities
// ---------------------------------------------------------------------------

/**
 * Walk upward from startPath to find the main project root — the directory
 * that contains a .git DIRECTORY (not file). Worktrees have a .git file that
 * points back to the main repo; we skip those and keep walking up.
 */
function findProjectRoot(startPath: string): string {
  let current = path.resolve(startPath);
  for (let i = 0; i < 30; i++) {
    const gitPath = path.join(current, ".git");
    if (existsSync(gitPath)) {
      try {
        if (statSync(gitPath).isDirectory()) return current;
      } catch {
        // stat failed — keep walking
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find project root (no .git directory) starting from ${startPath}`);
}

/**
 * Determine which branch a worktree is on via `git worktree list --porcelain`.
 */
function getBranchForWorktree(worktreePath: string, projectPath: string): string {
  const resolved = path.resolve(worktreePath);
  const listing = git(["worktree", "list", "--porcelain"], projectPath);
  const blocks = listing.split(/\n\n+/);
  for (const block of blocks) {
    const worktreeMatch = /^worktree (.+)$/m.exec(block);
    const branchMatch = /^branch refs\/heads\/(.+)$/m.exec(block);
    if (
      worktreeMatch &&
      branchMatch &&
      path.resolve(worktreeMatch[1]) === resolved
    ) {
      return branchMatch[1];
    }
  }
  throw new Error(`No worktree found at path: ${worktreePath}`);
}
