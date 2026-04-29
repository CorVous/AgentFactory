/**
 * Pure-function core for per-issue git worktree management.
 *
 * All git operations are performed via `child_process.execFileSync` (or the
 * async `execFile` wrapper below) so they run in the real filesystem — these
 * functions are tested against a real tmpdir git repo, not mocked.
 *
 * Scope (issue #03, happy path only):
 *   - `prepareWorktree`   — creates feature branch + worktree
 *   - `reintegrate`       — merges back into the mesh branch (AFK auto-merge)
 *   - `disposeWorktree`   — removes the worktree + branch ref
 *
 * Abort-cleanup tests and resilience paths are deferred to #03b.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Reintegration mode — derived from the issue's Status at dispatch time. */
export type ReintegrationMode = "auto-merge" | "branch-emit";

export interface PrepareResult {
  /** Absolute path to the newly-created per-issue worktree. */
  worktreePath: string;
  /** Full branch name for the per-issue work (e.g. `feature/my-slug-01-my-issue`). */
  branchName: string;
  /** Reintegration mode for this issue. */
  mode: ReintegrationMode;
}

export interface ReintegrationResult {
  /** SHA of the merge commit when mode === "auto-merge". */
  mergedCommit?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Derive the per-issue branch name from the mesh branch and the issue file path.
 *
 * Convention:  `feature/<feature-slug>-<NN>-<issue-slug>`
 *
 * The feature slug is everything after the last `/` in `meshBranch`
 * (e.g. `feature/v1-ralph-loop-mesh` → `v1-ralph-loop-mesh`).
 * The issue identifier is the basename of `issuePath` without the `.md` extension
 * (e.g. `.scratch/…/03-afk-trunk-end-to-end.md` → `03-afk-trunk-end-to-end`).
 */
export function issueBranchName(meshBranch: string, issuePath: string): string {
  const featureSlug = meshBranch.replace(/^[^/]+\//, "");
  const issueBase = path.basename(issuePath, ".md");
  return `feature/${featureSlug}-${issueBase}`;
}

/**
 * Derive the per-issue worktree path within the project.
 *
 * Convention:  `<projectPath>/.mesh-features/<featureSlug>/foreman-<NN>-<issueSlug>/`
 */
export function issueWorktreePath(projectPath: string, meshBranch: string, issuePath: string): string {
  const featureSlug = meshBranch.replace(/^[^/]+\//, "");
  const issueBase = path.basename(issuePath, ".md");
  return path.join(projectPath, ".mesh-features", featureSlug, `foreman-${issueBase}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a per-issue feature branch off `meshBranch` and add a git worktree
 * for it at the conventional path under `projectPath`.
 *
 * @param issuePath   Absolute path to the issue file (used for branch/path naming).
 * @param projectPath Absolute path to the project git repo root.
 * @param meshBranch  Full branch name of the mesh feature branch (e.g. `feature/my-slug`).
 * @param mode        Reintegration mode (`"auto-merge"` for `ready-for-agent`).
 */
export function prepareWorktree(
  issuePath: string,
  projectPath: string,
  meshBranch: string,
  mode: ReintegrationMode,
): PrepareResult {
  const branchName = issueBranchName(meshBranch, issuePath);
  const worktreePath = issueWorktreePath(projectPath, meshBranch, issuePath);

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Create the branch off meshBranch and add the worktree atomically.
  // `git worktree add -b <branch> <path> <base>` creates the branch and worktree.
  git(projectPath, "worktree", "add", "-b", branchName, worktreePath, meshBranch);

  return { worktreePath, branchName, mode };
}

/**
 * Merge the per-issue worktree's HEAD back into `meshBranch`.
 *
 * For `"auto-merge"`: run `git merge --no-ff` from the kanban worktree
 * (which is already on `meshBranch`). A merge commit is always produced
 * so the SHA is available in the result.
 *
 * For `"branch-emit"`: no-op — the branch is left as-is for the HITL path
 * (#04) to handle.
 *
 * @param worktreePath  Absolute path to the per-issue worktree.
 * @param mode          Reintegration mode.
 * @param meshBranch    Full branch name of the mesh feature branch.
 * @param kanbanWorktreePath  Absolute path to the Kanban's worktree (on `meshBranch`).
 */
export function reintegrate(
  worktreePath: string,
  mode: ReintegrationMode,
  meshBranch: string,
  kanbanWorktreePath: string,
): ReintegrationResult {
  if (mode !== "auto-merge") {
    // branch-emit: leave the branch; HITL path handles it (#04)
    return {};
  }

  // Get the branch name from the worktree
  const branchName = git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD");

  // Merge from the kanban worktree (which is on meshBranch)
  git(kanbanWorktreePath, "merge", "--no-ff", branchName, "-m",
    `Merge ${branchName} into ${meshBranch} [auto-merge]`);

  const mergedCommit = git(kanbanWorktreePath, "rev-parse", "HEAD");
  return { mergedCommit };
}

/**
 * Remove the per-issue worktree and delete the per-issue branch.
 *
 * Uses `git worktree remove --force` so uncommitted changes in the worktree
 * do not block cleanup (intentional for the AFK happy path; abort-cleanup
 * tests use the same function per #03b scope).
 *
 * @param worktreePath  Absolute path to the per-issue worktree.
 * @param projectPath   Absolute path to the project git repo root.
 */
export function disposeWorktree(worktreePath: string, projectPath: string): void {
  // Get the branch name before removing the worktree
  let branchName: string | undefined;
  try {
    branchName = git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD");
  } catch {
    // Worktree may already be gone; proceed with removal
  }

  // Remove the worktree
  try {
    git(projectPath, "worktree", "remove", "--force", worktreePath);
  } catch {
    // If already removed, that's fine
  }

  // Delete the per-issue branch
  if (branchName && branchName !== "HEAD" && branchName !== meshBranchFilter(branchName)) {
    try {
      git(projectPath, "branch", "-D", branchName);
    } catch {
      // Best-effort: branch may have already been deleted
    }
  }
}

/** Internal helper to avoid accidentally deleting non-feature branches. */
function meshBranchFilter(branchName: string): string {
  // Only delete branches that look like per-issue branches (feature/…-NN-slug)
  if (/^feature\/.+-\d{2}-/.test(branchName)) return "";
  return branchName; // return itself to trigger the "don't delete" guard
}
