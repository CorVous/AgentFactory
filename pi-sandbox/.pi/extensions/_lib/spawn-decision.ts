/**
 * Pure-function spawn-decision logic for the Kanban control plane.
 *
 * Given the current issue tree state and a map of running Foremen,
 * returns a list of spawn decisions — one per issue that should get a
 * new Foreman. No I/O, no model, no side effects: purely functional so
 * it is easy to unit-test.
 *
 * V1 simplifications (to be relaxed in later issues):
 *   - `maxConcurrent` is hardcoded to 1 (#06 wires the flag).
 *   - `Depends-on:` is not yet checked (#07 adds that filter).
 *   - Malformed-preamble handling is deferred to #03b.
 */

export type IssueStatus =
  | "ready-for-agent"
  | "ready-for-human"
  | "needs-triage"
  | "needs-info"
  | "wontfix"
  | "closed";

export interface IssueSummary {
  /** Absolute path to the issue file. */
  filePath: string;
  /** Parsed status from the preamble `Status:` line. */
  status: IssueStatus | string;
  /** Optional `Claimed-by:` value from the preamble. Absent → undefined. */
  claimedBy?: string;
}

export interface SpawnDecision {
  /** Absolute path to the issue file to dispatch a Foreman for. */
  issuePath: string;
}

/**
 * Parse the preamble block of an issue file (lines before the first `#` heading
 * or first blank line after any `Status:` / `Claimed-by:` lines).
 *
 * Returns a partial IssueSummary (no filePath filled in).
 */
export function parsePreamble(content: string): { status: string; claimedBy?: string } {
  let status = "";
  let claimedBy: string | undefined;
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    // Stop at the first `# ` heading or a line that's clearly body text
    if (line.startsWith("# ")) break;
    const statusMatch = line.match(/^Status:\s*(.+)$/);
    if (statusMatch) {
      status = statusMatch[1].trim();
      continue;
    }
    const claimMatch = line.match(/^Claimed-by:\s*(.+)$/);
    if (claimMatch) {
      claimedBy = claimMatch[1].trim();
      continue;
    }
  }
  return { status, claimedBy };
}

/**
 * Decide which issues should get a new Foreman spawned.
 *
 * Decision rules (V1, happy path only):
 *   1. Only `ready-for-agent` issues are eligible.
 *   2. An issue with a `Claimed-by:` line is already claimed — skip.
 *   3. An issue that already has a running Foreman (keyed by filePath) — skip.
 *   4. Respect `maxConcurrent`: stop once the sum of (running + to-spawn)
 *      reaches the cap. V1 hardcodes this to 1; #06 will pass it in.
 *
 * @param issues         Current open issue list (scanned from the issues/ dir).
 * @param runningForemen Set of issue file paths whose Foreman is currently live.
 * @param maxConcurrent  Maximum number of concurrently running Foremen. V1 = 1.
 */
export function spawnDecisions(
  issues: IssueSummary[],
  runningForemen: ReadonlySet<string>,
  maxConcurrent: number,
): SpawnDecision[] {
  const running = runningForemen.size;
  const decisions: SpawnDecision[] = [];

  for (const issue of issues) {
    if (running + decisions.length >= maxConcurrent) break;

    // Only dispatch AFK issues
    if (issue.status !== "ready-for-agent") continue;

    // Skip already-claimed issues
    if (issue.claimedBy !== undefined) continue;

    // Skip issues that already have a live Foreman
    if (runningForemen.has(issue.filePath)) continue;

    decisions.push({ issuePath: issue.filePath });
  }

  return decisions;
}
