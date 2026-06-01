// bundled-templates.test.ts — static guard: the canonical peer template ships
// in the engine package at agent/templates/peer.yaml (see #194).
//
// This test is hermetic and static — it reads the file and parses it with the
// `yaml` library; it does NOT invoke the pi runtime or resolveRecipe.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PEER_TEMPLATE = join(PACKAGE_DIR, "agent", "templates", "peer.yaml");

describe("bundled peer template", () => {
  it("exists at agent/templates/peer.yaml inside the engine package", () => {
    expect(existsSync(PEER_TEMPLATE)).toBe(true);
  });

  it("parses as valid YAML to a non-null object", () => {
    const raw = readFileSync(PEER_TEMPLATE, "utf8");
    const parsed = parseYaml(raw);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
  });

  it("contains a non-empty extensions array", () => {
    const raw = readFileSync(PEER_TEMPLATE, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    expect(Array.isArray(parsed["extensions"])).toBe(true);
    expect((parsed["extensions"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("lives under a path ending with agent/templates", () => {
    const templateDir = dirname(PEER_TEMPLATE);
    expect(templateDir.endsWith("agent/templates")).toBe(true);
  });
});
