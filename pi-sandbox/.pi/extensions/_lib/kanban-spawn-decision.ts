// Pure helper for the Kanban control-plane spawn decision.
// No FS, no model, no network — safe to test hermetically.
//
// Given the current issue tree state, the set of currently-running Foremen,
// and the concurrency cap, return which issues should be dispatched right now.

export interface IssueState {
  /** Relative path to the issue file (e.g. ".scratch/v1-ralph-loop-mesh/issues/03-foo.md"). */
  path: string;
  /** Value of the Status: line. */
  status: string;
  /** Value of the Claimed-by: line if present; undefined if absent. */
  claimedBy?: string;
  /**
   * Depends-on: paths listed in the issue file (if any).
   * Wired for the input shape so #07 can extend without changing the signature.
   * V1 does NOT honour this field — blocking logic ships in #07.
   */
  dependsOn?: string[];
}

export interface ForemanRef {
  /** The issue path this Foreman is working on. */
  issuePath: string;
}

export type SpawnMode = "auto-merge" | "branch-emit";

export interface SpawnDecision {
  issuePath: string;
  mode: SpawnMode;
}

const WORKABLE_STATUSES = new Set<string>(["ready-for-agent", "ready-for-human"]);

/**
 * Decide which issues should be dispatched as new Foremen right now.
 *
 * Selection rules:
 * - Issue status must be "ready-for-agent" or "ready-for-human".
 * - Issue must not already have a Claimed-by: line.
 * - Issue must not already be in currentForemen.
 * - Total (currentForemen.length + selected.length) must stay < maxConcurrent.
 * - dependsOn is accepted on the input shape but not yet enforced (#07 wires this).
 */
export function decideSpawns(
  issueTreeState: IssueState[],
  currentForemen: ForemanRef[],
  maxConcurrent: number,
): SpawnDecision[] {
  const runningPaths = new Set(currentForemen.map((f) => f.issuePath));
  const decisions: SpawnDecision[] = [];
  const remaining = maxConcurrent - currentForemen.length;

  for (const issue of issueTreeState) {
    if (decisions.length >= remaining) break;
    if (!WORKABLE_STATUSES.has(issue.status)) continue;
    if (issue.claimedBy !== undefined && issue.claimedBy !== "") continue;
    if (runningPaths.has(issue.path)) continue;

    const mode: SpawnMode =
      issue.status === "ready-for-human" ? "branch-emit" : "auto-merge";

    decisions.push({ issuePath: issue.path, mode });
  }

  return decisions;
}
