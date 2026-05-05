// Tests for recipe-resolver.mjs — resolveRecipe(name, fsContext) → effectiveRecipe
//
// Each test case maps to one acceptance criterion from the plan (Slice 2).
// All tests are hermetic: no model API calls, no network, no env vars from
// models.env, no real filesystem outside the test's tmpdir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRecipe } from "./recipe-resolver.mjs";

describe("recipe-resolver", () => {
  let tmpRoot: string;
  let agentsDir: string;
  let templatesDir: string;
  let extensionsDir: string;
  let fsContext: { agentsDir: string; templatesDir: string; extensionsDir: string };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-resolver-"));
    agentsDir = path.join(tmpRoot, "agents");
    templatesDir = path.join(tmpRoot, "templates");
    extensionsDir = path.join(tmpRoot, "extensions");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });
    fsContext = { agentsDir, templatesDir, extensionsDir };
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeRecipe(name: string, body: string): void {
    fs.writeFileSync(path.join(agentsDir, `${name}.yaml`), body, "utf8");
  }

  function writeTemplate(name: string, body: string): void {
    fs.writeFileSync(path.join(templatesDir, `${name}.yaml`), body, "utf8");
  }

  function writeExtension(name: string): void {
    fs.writeFileSync(path.join(extensionsDir, `${name}.ts`), "", "utf8");
  }

  // ---------------------------------------------------------------------------
  // AC 1: bare recipe (no extends:)
  // ---------------------------------------------------------------------------

  it("bare recipe with only recipe.extensions returns those extensions, deduped", () => {
    writeExtension("deferred-write");
    writeExtension("no-edit");
    writeRecipe(
      "my-agent",
      `prompt: You are a helper.\ntools:\n  - read\nextensions:\n  - deferred-write\n  - no-edit\n  - deferred-write\n`,
    );
    const result = resolveRecipe("my-agent", fsContext);
    expect(result.extensionList).toEqual(["deferred-write", "no-edit"]);
  });

  // ---------------------------------------------------------------------------
  // AC 2: recipe extending a template
  // ---------------------------------------------------------------------------

  it("recipe extending 'peer' returns template extensions in order", () => {
    writeExtension("habitat");
    writeExtension("sandbox");
    writeTemplate("peer", "extensions:\n  - habitat\n  - sandbox\n");
    writeRecipe(
      "my-agent",
      `extends: peer\nprompt: You are a helper.\ntools:\n  - read\n`,
    );
    const result = resolveRecipe("my-agent", fsContext);
    expect(result.extensionList).toEqual(["habitat", "sandbox"]);
  });

  // ---------------------------------------------------------------------------
  // AC 3: template extensions ++ recipe extensions, dedup
  // ---------------------------------------------------------------------------

  it("template ++ recipe extensions are merged, first-occurrence dedup wins", () => {
    writeExtension("habitat");
    writeExtension("sandbox");
    writeExtension("deferred-write");
    writeTemplate("peer", "extensions:\n  - habitat\n  - sandbox\n");
    writeRecipe(
      "my-agent",
      `extends: peer\nprompt: You are a helper.\ntools:\n  - read\nextensions:\n  - sandbox\n  - deferred-write\n`,
    );
    const result = resolveRecipe("my-agent", fsContext);
    // sandbox appears in template first; its second occurrence in recipe is dropped
    expect(result.extensionList).toEqual(["habitat", "sandbox", "deferred-write"]);
  });

  // ---------------------------------------------------------------------------
  // AC 4: non-existent extends: value throws
  // ---------------------------------------------------------------------------

  it("extends: ghost throws recipe-resolver: ... template not found", () => {
    writeRecipe(
      "my-agent",
      `extends: ghost\nprompt: You are a helper.\ntools:\n  - read\n`,
    );
    expect(() => resolveRecipe("my-agent", fsContext)).toThrow(
      /recipe-resolver:.*not found.*ghost/i,
    );
  });

  // ---------------------------------------------------------------------------
  // AC 5: non-existent extension in recipe list throws
  // ---------------------------------------------------------------------------

  it("recipe.extensions referencing missing extension throws", () => {
    writeExtension("habitat");
    writeRecipe(
      "my-agent",
      `prompt: You are a helper.\ntools:\n  - read\nextensions:\n  - habitat\n  - ghost-ext\n`,
    );
    expect(() => resolveRecipe("my-agent", fsContext)).toThrow(
      /recipe-resolver: extension 'ghost-ext' listed in recipe 'my-agent' not found/,
    );
  });

  // ---------------------------------------------------------------------------
  // AC 6: agents: implicitly adds atomic-delegate + delegate tool
  // ---------------------------------------------------------------------------

  it("recipe declaring agents: implicitly adds atomic-delegate to extensions and delegate to tools", () => {
    writeExtension("deferred-write");
    writeExtension("atomic-delegate");
    writeRecipe("child-agent", `prompt: I am a child.\ntools:\n  - read\n`);
    writeRecipe(
      "my-agent",
      `prompt: You are a helper.\ntools:\n  - read\nextensions:\n  - deferred-write\nagents:\n  - child-agent\n`,
    );
    const result = resolveRecipe("my-agent", fsContext);
    expect(result.extensionList).toContain("atomic-delegate");
    expect(result.tools).toContain("delegate");
    // recipe extension deferred-write appears before implicit atomic-delegate
    expect(result.extensionList.indexOf("deferred-write")).toBeLessThan(
      result.extensionList.indexOf("atomic-delegate"),
    );
  });

  // ---------------------------------------------------------------------------
  // AC 7: inverse rejection — extensions: [atomic-delegate] without agents:
  // ---------------------------------------------------------------------------

  it("recipe with extensions: [atomic-delegate] but no agents: throws inverse-rejection error", () => {
    writeExtension("atomic-delegate");
    writeRecipe(
      "bad-agent",
      `prompt: You are a helper.\ntools:\n  - read\nextensions:\n  - atomic-delegate\n`,
    );
    expect(() => resolveRecipe("bad-agent", fsContext)).toThrow(
      /recipe-resolver:.*atomic-delegate.*no 'agents:' list/,
    );
  });

  // ---------------------------------------------------------------------------
  // Structural: returned extensionList is a fresh array
  // ---------------------------------------------------------------------------

  it("returned extensionList is a fresh array (caller mutation does not leak between calls)", () => {
    writeExtension("deferred-write");
    writeRecipe(
      "my-agent",
      `prompt: You are a helper.\ntools:\n  - read\nextensions:\n  - deferred-write\n`,
    );
    const r1 = resolveRecipe("my-agent", fsContext);
    r1.extensionList.push("hacked");
    const r2 = resolveRecipe("my-agent", fsContext);
    expect(r2.extensionList).not.toContain("hacked");
    expect(r2.extensionList).toEqual(["deferred-write"]);
  });

  // ---------------------------------------------------------------------------
  // Structural: deprecated peer fields are rejected with recipe-resolver: prefix
  // ---------------------------------------------------------------------------

  it("recipe with deprecated peer field 'supervisor' is rejected with recipe-resolver: prefix", () => {
    writeRecipe(
      "bad-peer",
      `supervisor: some-lead\nprompt: You are a helper.\ntools:\n  - read\n`,
    );
    expect(() => resolveRecipe("bad-peer", fsContext)).toThrow(/^recipe-resolver:/);
  });

  // ---------------------------------------------------------------------------
  // Structural: agents: with non-existent child recipe throws
  // ---------------------------------------------------------------------------

  it("agents: with non-existent child recipe throws", () => {
    writeExtension("atomic-delegate");
    writeRecipe(
      "my-agent",
      `prompt: You are a helper.\ntools:\n  - read\nagents:\n  - no-such-recipe\n`,
    );
    expect(() => resolveRecipe("my-agent", fsContext)).toThrow(
      /recipe-resolver:.*no-such-recipe/,
    );
  });

  // ---------------------------------------------------------------------------
  // Structural: tools-side inverse rejection (delegate tool without agents:)
  // ---------------------------------------------------------------------------

  it("recipe with tools: [delegate] but no agents: throws inverse-rejection error", () => {
    writeRecipe(
      "bad-tools",
      `prompt: You are a helper.\ntools:\n  - delegate\n`,
    );
    expect(() => resolveRecipe("bad-tools", fsContext)).toThrow(
      /recipe-resolver:.*'delegate'.*no 'agents:' list/,
    );
  });

  // ---------------------------------------------------------------------------
  // Return shape: habitatSpecPartial contains expected fields
  // ---------------------------------------------------------------------------

  it("habitatSpecPartial includes skills, agents, noEditAdd, noEditSkip", () => {
    writeExtension("deferred-write");
    writeRecipe("child-agent", `prompt: I am a child.\ntools:\n  - read\n`);
    writeExtension("atomic-delegate");
    writeRecipe(
      "my-agent",
      [
        `prompt: You are a helper.`,
        `tools:`,
        `  - read`,
        `extensions:`,
        `  - deferred-write`,
        `skills:`,
        `  - pi-agent-builder`,
        `noEditAdd:`,
        `  - my_writer`,
        `noEditSkip:`,
        `  - deferred_write`,
        `agents:`,
        `  - child-agent`,
        `description: A helpful agent`,
        `model: TASK_RABBIT_MODEL`,
      ].join("\n"),
    );
    const result = resolveRecipe("my-agent", fsContext);
    expect(result.habitatSpecPartial.skills).toEqual(["pi-agent-builder"]);
    expect(result.habitatSpecPartial.agents).toEqual(["child-agent"]);
    expect(result.habitatSpecPartial.noEditAdd).toEqual(["my_writer"]);
    expect(result.habitatSpecPartial.noEditSkip).toEqual(["deferred_write"]);
    expect(result.habitatSpecPartial.description).toBe("A helpful agent");
    expect(result.habitatSpecPartial.tier).toBe("TASK_RABBIT_MODEL");
  });

  // ---------------------------------------------------------------------------
  // Return shape: promptFragments is [recipe.prompt.trim()]
  // ---------------------------------------------------------------------------

  it("promptFragments is a single-element array containing the trimmed recipe prompt", () => {
    writeRecipe(
      "my-agent",
      `prompt: |
  You are a helper.

tools:
  - read
`,
    );
    const result = resolveRecipe("my-agent", fsContext);
    expect(result.promptFragments).toHaveLength(1);
    expect(result.promptFragments[0]).toBe("You are a helper.");
  });

  // ---------------------------------------------------------------------------
  // Error handling: recipe file not found
  // ---------------------------------------------------------------------------

  it("missing recipe file throws with recipe-resolver: prefix", () => {
    expect(() => resolveRecipe("no-such-agent", fsContext)).toThrow(
      /recipe-resolver: recipe not found/,
    );
  });

  // ---------------------------------------------------------------------------
  // Error handling: malformed YAML
  // ---------------------------------------------------------------------------

  it("malformed recipe YAML throws with recipe-resolver: prefix", () => {
    writeRecipe("bad-yaml", "tools: [unclosed\n");
    expect(() => resolveRecipe("bad-yaml", fsContext)).toThrow(
      /recipe-resolver: failed to parse/,
    );
  });

  // ---------------------------------------------------------------------------
  // Error handling: missing prompt field
  // ---------------------------------------------------------------------------

  it("recipe missing prompt throws with recipe-resolver: prefix", () => {
    writeRecipe("no-prompt", `tools:\n  - read\n`);
    expect(() => resolveRecipe("no-prompt", fsContext)).toThrow(
      /recipe-resolver: recipe .* missing 'prompt'/,
    );
  });

  // ---------------------------------------------------------------------------
  // Error handling: missing tools field
  // ---------------------------------------------------------------------------

  it("recipe missing tools throws with recipe-resolver: prefix", () => {
    writeRecipe("no-tools", `prompt: You are a helper.\n`);
    expect(() => resolveRecipe("no-tools", fsContext)).toThrow(
      /recipe-resolver: recipe .* missing 'tools'/,
    );
  });

  // ---------------------------------------------------------------------------
  // Chain walk: template extends another template (forward-compat)
  // ---------------------------------------------------------------------------

  it("template chain walk: template extending another template is resolved recursively", () => {
    writeExtension("base-ext");
    writeExtension("mid-ext");
    writeExtension("top-ext");
    writeTemplate("base", "extensions:\n  - base-ext\n");
    writeTemplate("mid", "extends: base\nextensions:\n  - mid-ext\n");
    writeRecipe(
      "my-agent",
      `extends: mid\nprompt: You are a helper.\ntools:\n  - read\nextensions:\n  - top-ext\n`,
    );
    const result = resolveRecipe("my-agent", fsContext);
    expect(result.extensionList).toEqual(["base-ext", "mid-ext", "top-ext"]);
  });

  // ---------------------------------------------------------------------------
  // Chain walk: cycle detection
  // ---------------------------------------------------------------------------

  it("template cycle throws with recipe-resolver: prefix", () => {
    writeExtension("x-ext");
    writeTemplate("alpha", "extends: beta\nextensions:\n  - x-ext\n");
    writeTemplate("beta", "extends: alpha\nextensions:\n  - x-ext\n");
    writeRecipe(
      "my-agent",
      `extends: alpha\nprompt: You are a helper.\ntools:\n  - read\n`,
    );
    expect(() => resolveRecipe("my-agent", fsContext)).toThrow(
      /recipe-resolver:.*cycle/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Real-repo regression test: Slice 3 cutover invariants
//
// These tests resolve representative real recipes against the actual YAML
// files in pi-sandbox/agents/ and pi-sandbox/templates/ to guard that:
//   1. Every recipe resolves without error after `extends: peer` is added.
//   2. The extensionList starts with the full peer-template chain in order.
//   3. No duplicate `agent-bus` (or any other entry) appears in the list.
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REAL_AGENTS_DIR = path.join(REPO_ROOT, "pi-sandbox", "agents");
const REAL_TEMPLATES_DIR = path.join(REPO_ROOT, "pi-sandbox", "templates");
const REAL_EXTENSIONS_DIR = path.join(
  REPO_ROOT,
  "pi-sandbox",
  ".pi",
  "extensions",
);
const REAL_FS_CONTEXT = {
  agentsDir: REAL_AGENTS_DIR,
  templatesDir: REAL_TEMPLATES_DIR,
  extensionsDir: REAL_EXTENSIONS_DIR,
};

// The peer template's extension chain in declaration order.
const PEER_TEMPLATE_EXTENSIONS = [
  "habitat",
  "sandbox",
  "no-startup-help",
  "agent-header",
  "agent-footer",
  "hide-extensions-list",
  "deferred-confirm",
  "supervisor",
  "intercept",
  "agent-bus",
  "launcher-bridge",
  "slash-commands",
  "bus-tail-emitter",
  "mesh-rail",
];

describe("recipe-resolver real-repo recipes", () => {
  it("peer-chatter: resolves without error and extensionList begins with the full peer-template chain", () => {
    const result = resolveRecipe("peer-chatter", REAL_FS_CONTEXT);
    expect(result.extensionList.slice(0, PEER_TEMPLATE_EXTENSIONS.length)).toEqual(
      PEER_TEMPLATE_EXTENSIONS,
    );
  });

  it("peer-chatter: no duplicate agent-bus in extensionList", () => {
    const result = resolveRecipe("peer-chatter", REAL_FS_CONTEXT);
    const occurrences = result.extensionList.filter((n) => n === "agent-bus");
    expect(occurrences).toHaveLength(1);
  });

  it("deferred-writer: resolves without error and extensionList begins with the full peer-template chain", () => {
    const result = resolveRecipe("deferred-writer", REAL_FS_CONTEXT);
    expect(result.extensionList.slice(0, PEER_TEMPLATE_EXTENSIONS.length)).toEqual(
      PEER_TEMPLATE_EXTENSIONS,
    );
  });

  it("deferred-writer: no duplicate entries in extensionList", () => {
    const result = resolveRecipe("deferred-writer", REAL_FS_CONTEXT);
    const seen = new Set<string>();
    for (const ext of result.extensionList) {
      expect(seen.has(ext)).toBe(false);
      seen.add(ext);
    }
  });

  it("all real recipes resolve without error", () => {
    const recipes = fs
      .readdirSync(REAL_AGENTS_DIR)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.slice(0, -".yaml".length));
    for (const name of recipes) {
      expect(() => resolveRecipe(name, REAL_FS_CONTEXT)).not.toThrow();
    }
  });

  it("all real recipes with extends: peer have extensionList starting with the full peer-template chain", () => {
    const recipes = fs
      .readdirSync(REAL_AGENTS_DIR)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.slice(0, -".yaml".length));
    for (const name of recipes) {
      const raw = fs.readFileSync(
        path.join(REAL_AGENTS_DIR, `${name}.yaml`),
        "utf8",
      );
      if (!raw.includes("extends: peer")) continue;
      const result = resolveRecipe(name, REAL_FS_CONTEXT);
      expect(result.extensionList.slice(0, PEER_TEMPLATE_EXTENSIONS.length)).toEqual(
        PEER_TEMPLATE_EXTENSIONS,
      );
    }
  });
});
