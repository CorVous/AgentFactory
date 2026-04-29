/**
 * Hermetic unit tests for the issue-file helpers used by the
 * `ralph/orchestrator-thin` recipe.
 *
 * No model, no filesystem, no network, no env vars from models.env.
 */

import { describe, it, expect } from "vitest";
import {
  nextIssueNumber,
  titleToSlug,
  formatIssueFile,
  issueFilePath,
} from "./issue-file";

// ---------------------------------------------------------------------------
// nextIssueNumber
// ---------------------------------------------------------------------------

describe("nextIssueNumber", () => {
  it("returns '01' when the list is empty", () => {
    expect(nextIssueNumber([])).toBe("01");
  });

  it("returns '01' when no file has a numeric prefix", () => {
    expect(nextIssueNumber(["README.md", "PRD.md"])).toBe("01");
  });

  it("returns the next number after a single existing file", () => {
    expect(nextIssueNumber(["01-something.md"])).toBe("02");
  });

  it("returns the next number after several files (picks the max)", () => {
    expect(nextIssueNumber(["01-a.md", "03-c.md", "02-b.md"])).toBe("04");
  });

  it("zero-pads single-digit results to two digits", () => {
    const result = nextIssueNumber(["01-x.md", "02-y.md"]);
    expect(result).toBe("03");
    expect(result).toHaveLength(2);
  });

  it("handles paths that include subdirectory prefixes (e.g. closed/)", () => {
    expect(nextIssueNumber(["closed/05-done.md", "06-open.md"])).toBe("07");
  });

  it("handles two-digit existing numbers correctly", () => {
    expect(nextIssueNumber(["09-nine.md"])).toBe("10");
  });

  it("handles numbers ≥ 10 without leading zero in output", () => {
    const result = nextIssueNumber(["10-ten.md", "11-eleven.md"]);
    expect(result).toBe("12");
  });
});

// ---------------------------------------------------------------------------
// titleToSlug
// ---------------------------------------------------------------------------

describe("titleToSlug", () => {
  it("lowercases and hyphenates a simple title", () => {
    expect(titleToSlug("Add retry logic")).toBe("add-retry-logic");
  });

  it("collapses runs of non-alphanumeric chars to a single hyphen", () => {
    expect(titleToSlug("Fix: edge-case!")).toBe("fix-edge-case");
  });

  it("strips leading and trailing hyphens", () => {
    expect(titleToSlug("  Spaces  ")).toBe("spaces");
  });

  it("handles punctuation-heavy titles", () => {
    expect(titleToSlug("(RFC) Add TLS support")).toBe("rfc-add-tls-support");
  });

  it("handles a title that is already a slug", () => {
    expect(titleToSlug("already-a-slug")).toBe("already-a-slug");
  });

  it("returns an empty string for an all-punctuation input", () => {
    expect(titleToSlug("!!!")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// issueFilePath
// ---------------------------------------------------------------------------

describe("issueFilePath", () => {
  it("constructs the canonical relative path", () => {
    expect(issueFilePath("v1-ralph-loop-mesh", "03", "add-retry-logic")).toBe(
      ".scratch/v1-ralph-loop-mesh/issues/03-add-retry-logic.md",
    );
  });

  it("works for NN = '01'", () => {
    expect(issueFilePath("my-feature", "01", "first-issue")).toBe(
      ".scratch/my-feature/issues/01-first-issue.md",
    );
  });
});

// ---------------------------------------------------------------------------
// formatIssueFile — structure and preamble
// ---------------------------------------------------------------------------

describe("formatIssueFile — Status line", () => {
  it("emits 'Status: ready-for-agent' when status is ready-for-agent", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "My Issue",
      body: "Do the thing.",
    });
    expect(content).toMatch(/^Status: ready-for-agent$/m);
  });

  it("emits 'Status: ready-for-human' when status is ready-for-human", () => {
    const content = formatIssueFile({
      status: "ready-for-human",
      title: "My Issue",
      body: "Do the thing.",
    });
    expect(content).toMatch(/^Status: ready-for-human$/m);
  });
});

describe("formatIssueFile — Depends-on line", () => {
  it("omits Depends-on when dependsOn is not provided", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "My Issue",
      body: "Body text.",
    });
    expect(content).not.toMatch(/Depends-on/);
  });

  it("includes Depends-on when dependsOn is provided", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "My Issue",
      body: "Body text.",
      dependsOn: "01-some-blocker.md",
    });
    expect(content).toMatch(/^Depends-on: 01-some-blocker\.md$/m);
  });

  it("Depends-on appears immediately after the Status line", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "My Issue",
      body: "Body.",
      dependsOn: "../issues/02-other.md",
    });
    const lines = content.split("\n");
    const statusIdx = lines.findIndex((l) => l.startsWith("Status:"));
    const dependsIdx = lines.findIndex((l) => l.startsWith("Depends-on:"));
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(dependsIdx).toBe(statusIdx + 1);
  });
});

describe("formatIssueFile — heading and body shape", () => {
  it("contains the title as a top-level heading", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "Build the widget",
      body: "Body.",
    });
    expect(content).toMatch(/^# Build the widget$/m);
  });

  it("contains the body under '## What to build'", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "T",
      body: "Do the specific thing here.",
    });
    expect(content).toContain("## What to build");
    expect(content).toContain("Do the specific thing here.");
    const whatIdx = content.indexOf("## What to build");
    const bodyIdx = content.indexOf("Do the specific thing here.");
    expect(bodyIdx).toBeGreaterThan(whatIdx);
  });

  it("ends with an empty '## Comments' section", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "T",
      body: "B.",
    });
    expect(content).toMatch(/## Comments/);
    // The Comments section should come after the body
    const commentsIdx = content.indexOf("## Comments");
    const bodyIdx = content.indexOf("B.");
    expect(commentsIdx).toBeGreaterThan(bodyIdx);
  });

  it("uses '(no PRD)' when prdPath is omitted", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "T",
      body: "B.",
    });
    expect(content).toContain("(no PRD)");
  });

  it("uses the provided prdPath in the Parent section", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "T",
      body: "B.",
      prdPath: "../PRD.md",
    });
    expect(content).toContain("../PRD.md");
    expect(content).not.toContain("(no PRD)");
  });

  it("trims leading/trailing whitespace from the body", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "T",
      body: "   trimmed body   ",
    });
    expect(content).toContain("trimmed body");
    expect(content).not.toContain("   trimmed body   ");
  });
});

describe("formatIssueFile — blank line between preamble and heading", () => {
  it("has a blank line between the last preamble line and the # heading", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "My Issue",
      body: "Body.",
    });
    // The line before "# My Issue" must be blank
    const lines = content.split("\n");
    const headingIdx = lines.findIndex((l) => l === "# My Issue");
    expect(headingIdx).toBeGreaterThan(0);
    expect(lines[headingIdx - 1]).toBe("");
  });

  it("still has a blank line before heading when Depends-on is present", () => {
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "My Issue",
      body: "Body.",
      dependsOn: "01-blocker.md",
    });
    const lines = content.split("\n");
    const headingIdx = lines.findIndex((l) => l === "# My Issue");
    expect(headingIdx).toBeGreaterThan(0);
    expect(lines[headingIdx - 1]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Integrated fixture: simulate a model-produced issue file
// ---------------------------------------------------------------------------

describe("integrated fixture — orchestrator-thin workflow", () => {
  it("produces a well-formed issue file from a fixture prompt scenario", () => {
    // Simulate: existing issues [01, 02] in v1-ralph-loop-mesh, user wants
    // a new ready-for-agent issue titled 'Add retry logic' that depends on #02.
    const existingPaths = [
      "01-thin-orchestrator.md",
      "closed/02-mesh-setup.md",
    ];
    const nn = nextIssueNumber(existingPaths);
    const slug = titleToSlug("Add retry logic");
    const filePath = issueFilePath("v1-ralph-loop-mesh", nn, slug);
    const content = formatIssueFile({
      status: "ready-for-agent",
      title: "Add retry logic",
      body: "Implement exponential back-off in the mesh node transport layer.",
      prdPath: "../PRD.md",
      dependsOn: ".scratch/v1-ralph-loop-mesh/issues/01-thin-orchestrator.md",
    });

    // Path assertions
    expect(nn).toBe("03");
    expect(slug).toBe("add-retry-logic");
    expect(filePath).toBe(".scratch/v1-ralph-loop-mesh/issues/03-add-retry-logic.md");

    // Status line
    expect(content).toMatch(/^Status: ready-for-agent$/m);

    // Depends-on line present
    expect(content).toMatch(/^Depends-on:/m);

    // No Claimed-by line (new issues are unclaimed)
    expect(content).not.toMatch(/Claimed-by/);

    // Title heading
    expect(content).toMatch(/^# Add retry logic$/m);

    // Body present under the right section
    expect(content).toContain("## What to build");
    expect(content).toContain("Implement exponential back-off");

    // PRD reference present
    expect(content).toContain("../PRD.md");

    // Comments section present at the end
    expect(content).toMatch(/## Comments/);
  });
});
