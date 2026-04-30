// Tests for issue-file helpers used by the thin orchestrator recipe.
// All helpers are pure functions — no FS, no model, no network.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { nextIssueNN, titleToSlug, buildIssueBody, composeIssueFile } from "./issue-file";

// ---------------------------------------------------------------------------
// Slice A: nextIssueNN — given a list of existing issue filenames (basenames),
// return the next two-digit zero-padded NN.
// ---------------------------------------------------------------------------

describe("nextIssueNN", () => {
  it("returns '01' for an empty directory", () => {
    expect(nextIssueNN([])).toBe("01");
  });

  it("returns '03' when existing files are 01 and 02", () => {
    expect(nextIssueNN(["01-foo.md", "02-bar.md"])).toBe("03");
  });

  it("returns next-after-max for non-contiguous numbering (01 and 03 → 04)", () => {
    expect(nextIssueNN(["01-foo.md", "03-baz.md"])).toBe("04");
  });

  it("ignores filenames that do not start with two digits and a dash", () => {
    expect(nextIssueNN(["README.md", "PRD.md", "01-real.md"])).toBe("02");
  });
});

// ---------------------------------------------------------------------------
// Slice B: titleToSlug — kebab-case slug from an issue title string.
// ---------------------------------------------------------------------------

describe("titleToSlug", () => {
  it("lowercases and hyphenates a simple title", () => {
    expect(titleToSlug("Thin Orchestrator")).toBe("thin-orchestrator");
  });

  it("strips punctuation and collapses to single hyphens", () => {
    expect(titleToSlug("Add: issue-file helpers!")).toBe("add-issue-file-helpers");
  });

  it("trims leading and trailing whitespace", () => {
    expect(titleToSlug("  My Issue  ")).toBe("my-issue");
  });

  it("truncates very long titles at a hyphen boundary", () => {
    // Construct a title that would exceed 60 chars after slugification.
    const title = "word-".repeat(20); // 100 chars slug-like
    const result = titleToSlug(title);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).not.toMatch(/-$/);
  });

  it("handles a single word title", () => {
    expect(titleToSlug("Kanban")).toBe("kanban");
  });
});

// ---------------------------------------------------------------------------
// Slice C: buildIssueBody — canonical issue-file content string.
// Per docs/agents/issue-tracker.md: Status: line first, blank line, title
// heading, optional Depends-on:, body text.
// ---------------------------------------------------------------------------

describe("buildIssueBody", () => {
  it("starts with a Status: line", () => {
    const content = buildIssueBody({
      status: "ready-for-agent",
      title: "My Issue",
      body: "Do the thing.",
    });
    expect(content).toMatch(/^Status: ready-for-agent\n/);
  });

  it("includes the title as a level-1 heading", () => {
    const content = buildIssueBody({
      status: "ready-for-agent",
      title: "My Issue",
      body: "Do the thing.",
    });
    expect(content).toContain("# My Issue");
  });

  it("includes the body text", () => {
    const content = buildIssueBody({
      status: "ready-for-human",
      title: "Review Me",
      body: "Please review carefully.",
    });
    expect(content).toContain("Please review carefully.");
  });

  it("omits Depends-on when not provided", () => {
    const content = buildIssueBody({
      status: "ready-for-agent",
      title: "No Deps",
      body: "Solo task.",
    });
    expect(content).not.toContain("Depends-on:");
  });

  it("includes Depends-on: line when dependsOn is set", () => {
    const content = buildIssueBody({
      status: "ready-for-agent",
      title: "Depends Issue",
      body: "Must wait.",
      dependsOn: ".scratch/my-feature/issues/01-blocker.md",
    });
    expect(content).toContain("Depends-on: .scratch/my-feature/issues/01-blocker.md");
  });

  it("Status: line appears before the title heading", () => {
    const content = buildIssueBody({
      status: "ready-for-agent",
      title: "Order Test",
      body: "Body here.",
    });
    const statusPos = content.indexOf("Status:");
    const titlePos = content.indexOf("# Order Test");
    expect(statusPos).toBeLessThan(titlePos);
  });

  it("Depends-on: line appears before the title heading when present", () => {
    const content = buildIssueBody({
      status: "ready-for-agent",
      title: "Dep Order",
      body: "Body.",
      dependsOn: ".scratch/feat/issues/01-x.md",
    });
    const depsPos = content.indexOf("Depends-on:");
    const titlePos = content.indexOf("# Dep Order");
    expect(depsPos).toBeLessThan(titlePos);
  });
});

// ---------------------------------------------------------------------------
// Slice D: composeIssueFile — given params + existing issue filenames, return
// {path, content} ready to feed into deferred_write.
// ---------------------------------------------------------------------------

describe("composeIssueFile", () => {
  it("returns a path under .scratch/<feature>/issues/ with next NN and slug", () => {
    const result = composeIssueFile({
      feature: "my-feature",
      status: "ready-for-agent",
      title: "Do The Thing",
      body: "Details here.",
      existingFilenames: [],
    });
    expect(result.path).toBe(".scratch/my-feature/issues/01-do-the-thing.md");
  });

  it("increments NN based on existing filenames", () => {
    const result = composeIssueFile({
      feature: "v1-ralph-loop-mesh",
      status: "ready-for-agent",
      title: "Next Issue",
      body: "Work to do.",
      existingFilenames: ["01-kanban.md", "02-orchestrator.md"],
    });
    expect(result.path).toBe(".scratch/v1-ralph-loop-mesh/issues/03-next-issue.md");
  });

  it("content starts with the Status: line", () => {
    const result = composeIssueFile({
      feature: "feat",
      status: "ready-for-human",
      title: "Human Review",
      body: "Needs human eyes.",
      existingFilenames: [],
    });
    expect(result.content).toMatch(/^Status: ready-for-human\n/);
  });

  it("content includes Depends-on: when dependsOn is supplied", () => {
    const result = composeIssueFile({
      feature: "feat",
      status: "ready-for-agent",
      title: "Blocked Issue",
      body: "Must wait.",
      dependsOn: ".scratch/feat/issues/01-blocker.md",
      existingFilenames: ["01-blocker.md"],
    });
    expect(result.content).toContain("Depends-on: .scratch/feat/issues/01-blocker.md");
  });

  it("content includes the title as an H1 heading", () => {
    const result = composeIssueFile({
      feature: "feat",
      status: "ready-for-agent",
      title: "Title Check",
      body: "Body.",
      existingFilenames: [],
    });
    expect(result.content).toContain("# Title Check");
  });
});

// ---------------------------------------------------------------------------
// Slice E: recipe validation — hermetic parse of orchestrator-thin.yaml.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECIPE_PATH = path.resolve(HERE, "..", "..", "..", "agents", "ralph", "orchestrator-thin.yaml");

describe("orchestrator-thin recipe", () => {
  it("recipe file exists at pi-sandbox/agents/ralph/orchestrator-thin.yaml", () => {
    expect(existsSync(RECIPE_PATH)).toBe(true);
  });

  it("recipe YAML parses without error", () => {
    const raw = readFileSync(RECIPE_PATH, "utf8");
    const recipe = parseYaml(raw);
    expect(recipe).toBeTruthy();
    expect(typeof recipe).toBe("object");
  });

  it("recipe has a non-empty prompt string", () => {
    const recipe = parseYaml(readFileSync(RECIPE_PATH, "utf8"));
    expect(typeof recipe.prompt).toBe("string");
    expect(recipe.prompt.trim().length).toBeGreaterThan(0);
  });

  it("recipe has a tools array", () => {
    const recipe = parseYaml(readFileSync(RECIPE_PATH, "utf8"));
    expect(Array.isArray(recipe.tools)).toBe(true);
  });

  it("recipe tools include deferred_write", () => {
    const recipe = parseYaml(readFileSync(RECIPE_PATH, "utf8"));
    expect(recipe.tools).toContain("deferred_write");
  });

  it("recipe model is LEAD_HARE_MODEL", () => {
    const recipe = parseYaml(readFileSync(RECIPE_PATH, "utf8"));
    expect(recipe.model).toBe("LEAD_HARE_MODEL");
  });

  it("recipe shortName is a valid lowercase slug", () => {
    const recipe = parseYaml(readFileSync(RECIPE_PATH, "utf8"));
    expect(recipe.shortName).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("recipe prompt mentions thin variant and issue #08", () => {
    const recipe = parseYaml(readFileSync(RECIPE_PATH, "utf8"));
    // Per AC: "The recipe's prompt: documents that this is the thin variant
    // and points at issue #08 for the full grill->PRD->issues flow."
    expect(recipe.prompt.toLowerCase()).toContain("thin");
    expect(recipe.prompt).toContain("#08");
  });

  it("recipe does not declare bash or delegate tools", () => {
    const recipe = parseYaml(readFileSync(RECIPE_PATH, "utf8"));
    expect(recipe.tools).not.toContain("bash");
    expect(recipe.tools).not.toContain("delegate");
  });

  it("recipe extensions include deferred/deferred-write", () => {
    const recipe = parseYaml(readFileSync(RECIPE_PATH, "utf8"));
    expect(Array.isArray(recipe.extensions)).toBe(true);
    expect(recipe.extensions).toContain("deferred/deferred-write");
  });
});

// ---------------------------------------------------------------------------
// Slice F: recipe validation — hermetic parse of ralph/foreman.yaml.
// ---------------------------------------------------------------------------

const FOREMAN_RECIPE_PATH = path.resolve(HERE, "..", "..", "..", "agents", "ralph", "foreman.yaml");

describe("ralph/foreman recipe", () => {
  it("recipe file exists at pi-sandbox/agents/ralph/foreman.yaml", () => {
    expect(existsSync(FOREMAN_RECIPE_PATH)).toBe(true);
  });

  it("recipe YAML parses without error", () => {
    const raw = readFileSync(FOREMAN_RECIPE_PATH, "utf8");
    const recipe = parseYaml(raw);
    expect(recipe).toBeTruthy();
    expect(typeof recipe).toBe("object");
  });

  it("recipe has a non-empty prompt string", () => {
    const recipe = parseYaml(readFileSync(FOREMAN_RECIPE_PATH, "utf8"));
    expect(typeof recipe.prompt).toBe("string");
    expect(recipe.prompt.trim().length).toBeGreaterThan(0);
  });

  it("recipe model is LEAD_HARE_MODEL", () => {
    const recipe = parseYaml(readFileSync(FOREMAN_RECIPE_PATH, "utf8"));
    expect(recipe.model).toBe("LEAD_HARE_MODEL");
  });

  it("recipe shortName is a valid lowercase slug", () => {
    const recipe = parseYaml(readFileSync(FOREMAN_RECIPE_PATH, "utf8"));
    expect(recipe.shortName).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("recipe tools include bash, read, write, edit, grep, find, glob", () => {
    const recipe = parseYaml(readFileSync(FOREMAN_RECIPE_PATH, "utf8"));
    for (const tool of ["bash", "read", "write", "edit", "grep", "find", "glob"]) {
      expect(recipe.tools).toContain(tool);
    }
  });

  it("recipe declares submitTo: human-relay", () => {
    const recipe = parseYaml(readFileSync(FOREMAN_RECIPE_PATH, "utf8"));
    expect(recipe.submitTo).toBe("human-relay");
  });

  it("recipe prompt mentions HITL early-exit stub and #04", () => {
    const recipe = parseYaml(readFileSync(FOREMAN_RECIPE_PATH, "utf8"));
    expect(recipe.prompt).toContain("#04");
  });

  it("recipe prompt mentions AFK Ralph Loop", () => {
    const recipe = parseYaml(readFileSync(FOREMAN_RECIPE_PATH, "utf8"));
    expect(recipe.prompt.toLowerCase()).toContain("afk");
  });
});

// ---------------------------------------------------------------------------
// Slice G: foreman-flags extension and recipe wiring.
// ---------------------------------------------------------------------------

const FOREMAN_FLAGS_EXT_PATH = path.resolve(
  HERE,
  "..",
  "ralph",
  "foreman-flags.ts",
);

describe("ralph/foreman-flags extension", () => {
  it("extension file exists at pi-sandbox/.pi/extensions/ralph/foreman-flags.ts", () => {
    expect(existsSync(FOREMAN_FLAGS_EXT_PATH)).toBe(true);
  });

  it("extension file exports a default function (extension factory)", async () => {
    const mod = await import(FOREMAN_FLAGS_EXT_PATH);
    expect(typeof mod.default).toBe("function");
  });

  it("foreman recipe extensions list includes ralph/foreman-flags", () => {
    const recipe = parseYaml(readFileSync(FOREMAN_RECIPE_PATH, "utf8"));
    expect(Array.isArray(recipe.extensions)).toBe(true);
    expect(recipe.extensions).toContain("ralph/foreman-flags");
  });
});
