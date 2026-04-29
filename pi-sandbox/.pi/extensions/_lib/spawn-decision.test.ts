/**
 * Hermetic unit tests for spawn-decision.ts
 *
 * No model, no filesystem, no network, no env vars.
 */

import { describe, it, expect } from "vitest";
import {
  spawnDecisions,
  parsePreamble,
  type IssueSummary,
} from "./spawn-decision";

// ---------------------------------------------------------------------------
// parsePreamble
// ---------------------------------------------------------------------------

describe("parsePreamble", () => {
  it("extracts Status from a minimal preamble", () => {
    const content = "Status: ready-for-agent\n\n# My Issue\n";
    expect(parsePreamble(content).status).toBe("ready-for-agent");
  });

  it("extracts Claimed-by when present", () => {
    const content = "Status: ready-for-agent\nClaimed-by: cottontail-foreman\n\n# Title\n";
    const r = parsePreamble(content);
    expect(r.status).toBe("ready-for-agent");
    expect(r.claimedBy).toBe("cottontail-foreman");
  });

  it("returns undefined claimedBy when absent", () => {
    const content = "Status: ready-for-agent\n\n# Title\n";
    expect(parsePreamble(content).claimedBy).toBeUndefined();
  });

  it("stops parsing at the first heading line", () => {
    const content = "# Title\nStatus: ready-for-agent\n";
    // Status line appears after the heading — should NOT be picked up
    expect(parsePreamble(content).status).toBe("");
  });

  it("returns empty status when file has no Status: line", () => {
    const content = "Just some text\n";
    expect(parsePreamble(content).status).toBe("");
  });

  it("trims whitespace from status value", () => {
    const content = "Status:   ready-for-human   \n\n# Title\n";
    expect(parsePreamble(content).status).toBe("ready-for-human");
  });
});

// ---------------------------------------------------------------------------
// spawnDecisions — happy path
// ---------------------------------------------------------------------------

describe("spawnDecisions — ready issue selected", () => {
  it("returns one decision for a single ready-for-agent issue", () => {
    const issues: IssueSummary[] = [
      { filePath: "/scratch/issues/01-my-issue.md", status: "ready-for-agent" },
    ];
    const decisions = spawnDecisions(issues, new Set(), 1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].issuePath).toBe("/scratch/issues/01-my-issue.md");
  });

  it("does not exceed maxConcurrent=1 when multiple issues are ready", () => {
    const issues: IssueSummary[] = [
      { filePath: "/scratch/issues/01-issue-a.md", status: "ready-for-agent" },
      { filePath: "/scratch/issues/02-issue-b.md", status: "ready-for-agent" },
    ];
    const decisions = spawnDecisions(issues, new Set(), 1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].issuePath).toBe("/scratch/issues/01-issue-a.md");
  });

  it("respects maxConcurrent=2 when two issues are ready", () => {
    const issues: IssueSummary[] = [
      { filePath: "/scratch/issues/01-issue-a.md", status: "ready-for-agent" },
      { filePath: "/scratch/issues/02-issue-b.md", status: "ready-for-agent" },
    ];
    const decisions = spawnDecisions(issues, new Set(), 2);
    expect(decisions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// spawnDecisions — claimed issue skipped
// ---------------------------------------------------------------------------

describe("spawnDecisions — claimed issue skipped", () => {
  it("skips an issue that has Claimed-by set", () => {
    const issues: IssueSummary[] = [
      {
        filePath: "/scratch/issues/01-claimed.md",
        status: "ready-for-agent",
        claimedBy: "cottontail-foreman",
      },
    ];
    const decisions = spawnDecisions(issues, new Set(), 1);
    expect(decisions).toHaveLength(0);
  });

  it("skips a claimed issue but picks up an unclaimed one", () => {
    const issues: IssueSummary[] = [
      {
        filePath: "/scratch/issues/01-claimed.md",
        status: "ready-for-agent",
        claimedBy: "some-foreman",
      },
      {
        filePath: "/scratch/issues/02-open.md",
        status: "ready-for-agent",
      },
    ];
    const decisions = spawnDecisions(issues, new Set(), 1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].issuePath).toBe("/scratch/issues/02-open.md");
  });
});

// ---------------------------------------------------------------------------
// spawnDecisions — already-running Foreman skipped
// ---------------------------------------------------------------------------

describe("spawnDecisions — running Foreman skipped", () => {
  it("skips an issue whose filePath is in runningForemen", () => {
    const fp = "/scratch/issues/01-running.md";
    const issues: IssueSummary[] = [{ filePath: fp, status: "ready-for-agent" }];
    const decisions = spawnDecisions(issues, new Set([fp]), 1);
    expect(decisions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// spawnDecisions — non-agent statuses skipped
// ---------------------------------------------------------------------------

describe("spawnDecisions — non-agent statuses skipped", () => {
  it("skips ready-for-human issues", () => {
    const issues: IssueSummary[] = [
      { filePath: "/scratch/issues/01-hitl.md", status: "ready-for-human" },
    ];
    expect(spawnDecisions(issues, new Set(), 1)).toHaveLength(0);
  });

  it("skips needs-triage issues", () => {
    const issues: IssueSummary[] = [
      { filePath: "/scratch/issues/01-untriaged.md", status: "needs-triage" },
    ];
    expect(spawnDecisions(issues, new Set(), 1)).toHaveLength(0);
  });

  it("returns empty list when issues array is empty", () => {
    expect(spawnDecisions([], new Set(), 1)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// spawnDecisions — concurrency already at cap
// ---------------------------------------------------------------------------

describe("spawnDecisions — cap already reached", () => {
  it("returns no decisions when runningForemen.size >= maxConcurrent", () => {
    const issues: IssueSummary[] = [
      { filePath: "/scratch/issues/01-new.md", status: "ready-for-agent" },
    ];
    const running = new Set(["/scratch/issues/99-other.md"]);
    const decisions = spawnDecisions(issues, running, 1);
    expect(decisions).toHaveLength(0);
  });
});
