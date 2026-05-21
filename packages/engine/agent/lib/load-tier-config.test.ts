// load-tier-config.test.ts — hermetic unit tests for the I/O loader.
// Uses os.tmpdir() only — never reads from the real ~/.pi path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// We import the functions under test after setting up the environment.
// loadBundledDefaults reads from import.meta.url so it always finds the
// real tier-defaults.json; loadOverrideConfig is tested with a tmpdir.
import {
  loadBundledDefaults,
  loadOverrideConfig,
} from "./load-tier-config.js";

const TIER_VARS = ["RABBIT_SAGE_MODEL", "LEAD_HARE_MODEL", "TASK_RABBIT_MODEL"];

describe("loadBundledDefaults", () => {
  it("returns all three tiers", () => {
    const defaults = loadBundledDefaults();
    for (const tier of TIER_VARS) {
      expect(defaults).toHaveProperty(tier);
      expect(typeof defaults[tier]).toBe("string");
      expect(defaults[tier].length).toBeGreaterThan(0);
    }
  });

  it("matches the values in models.env", () => {
    const defaults = loadBundledDefaults();
    // These are the values from models.env at the time of Slice 3 implementation.
    expect(defaults["RABBIT_SAGE_MODEL"]).toBe("xiaomi/mimo-v2-pro");
    expect(defaults["LEAD_HARE_MODEL"]).toBe("google/gemini-3-flash-preview");
    expect(defaults["TASK_RABBIT_MODEL"]).toBe("deepseek/deepseek-v3.2");
  });
});

describe("loadOverrideConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdirSync(path.join(os.tmpdir(), `pi-test-${Date.now()}`), {
      recursive: true,
    }) as unknown as string;
    // mkdirSync with recursive returns string | undefined — handle both.
    if (!tmpDir) {
      // Fallback: derive the path ourselves.
      tmpDir = path.join(os.tmpdir(), `pi-test-${Date.now()}`);
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a valid JSON file and returns the map", () => {
    const overrideFile = path.join(tmpDir, "models.json");
    writeFileSync(
      overrideFile,
      JSON.stringify({ TASK_RABBIT_MODEL: "override/rabbit" }),
      "utf8",
    );
    const result = loadOverrideConfig(overrideFile);
    expect(result).toEqual({ TASK_RABBIT_MODEL: "override/rabbit" });
  });

  it("returns {} when the file is missing (non-fatal)", () => {
    const result = loadOverrideConfig(path.join(tmpDir, "nonexistent.json"));
    expect(result).toEqual({});
  });

  it("returns {} for malformed JSON without throwing (non-fatal)", () => {
    const badFile = path.join(tmpDir, "bad.json");
    writeFileSync(badFile, "not json at all {{{", "utf8");
    const result = loadOverrideConfig(badFile);
    expect(result).toEqual({});
  });

  it("filters out non-tier keys", () => {
    const overrideFile = path.join(tmpDir, "models.json");
    writeFileSync(
      overrideFile,
      JSON.stringify({
        TASK_RABBIT_MODEL: "override/rabbit",
        SOME_UNKNOWN_KEY: "ignored",
        another_key: "also ignored",
      }),
      "utf8",
    );
    const result = loadOverrideConfig(overrideFile);
    expect(result).toEqual({ TASK_RABBIT_MODEL: "override/rabbit" });
    expect(result).not.toHaveProperty("SOME_UNKNOWN_KEY");
    expect(result).not.toHaveProperty("another_key");
  });

  it("handles all three tier keys when present", () => {
    const overrideFile = path.join(tmpDir, "models.json");
    writeFileSync(
      overrideFile,
      JSON.stringify({
        RABBIT_SAGE_MODEL: "override/sage",
        LEAD_HARE_MODEL: "override/hare",
        TASK_RABBIT_MODEL: "override/rabbit",
      }),
      "utf8",
    );
    const result = loadOverrideConfig(overrideFile);
    expect(result).toEqual({
      RABBIT_SAGE_MODEL: "override/sage",
      LEAD_HARE_MODEL: "override/hare",
      TASK_RABBIT_MODEL: "override/rabbit",
    });
  });

  it("returns {} for an empty object JSON file", () => {
    const overrideFile = path.join(tmpDir, "models.json");
    writeFileSync(overrideFile, "{}", "utf8");
    const result = loadOverrideConfig(overrideFile);
    expect(result).toEqual({});
  });
});
