/**
 * recipe-loader.test.ts — source-level assertions for the engine's
 * recipe-loader extension (packages/engine/agent/extensions/recipe-loader.ts).
 *
 * Verifies:
 *   1. The failHard helper exists, writes to stderr, and throws.
 *   2. Fatal error paths (resolveRecipe, resolveRailPackages, missing clusters,
 *      resolveModel, topology-overlay JSON parse, setHabitat) use failHard.
 *   3. Non-fatal paths (skill resolution, missing API key, unknown model,
 *      invalid tool names) still use "warning" and do NOT use failHard.
 *
 * Contract: pure file-content assertions; no jiti, no pi runtime, no I/O
 * beyond reading the sibling source file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "recipe-loader.ts"), "utf8");

describe("recipe-loader.ts — failHard helper (issue #173)", () => {
  it("defines a failHard helper function", () => {
    expect(SRC).toMatch(/function\s+failHard\s*\(/);
  });

  it("failHard writes to process.stderr", () => {
    expect(SRC).toMatch(/process\.stderr\.write/);
  });

  it("failHard throws (not just notify-and-return)", () => {
    // Slice the source from the failHard function definition onwards and
    // verify 'throw new Error' appears before the next top-level function.
    const failHardIdx = SRC.indexOf("function failHard(");
    expect(failHardIdx).toBeGreaterThan(-1);
    const failHardBody = SRC.slice(failHardIdx, failHardIdx + 300);
    expect(failHardBody).toMatch(/throw new Error/);
  });

  it("failHard calls ctx.ui.notify so interactive TUI gets an error toast", () => {
    const failHardIdx = SRC.indexOf("function failHard(");
    expect(failHardIdx).toBeGreaterThan(-1);
    const failHardBody = SRC.slice(failHardIdx, failHardIdx + 300);
    expect(failHardBody).toMatch(/ctx\.ui\.notify/);
  });

  it("failHard is declared with return type never", () => {
    expect(SRC).toMatch(/function\s+failHard\s*\([^)]*\)\s*:\s*never/);
  });
});

describe("recipe-loader.ts — fatal error paths use failHard (issue #173)", () => {
  it("uses failHard for resolveRecipe failure", () => {
    // After the resolveRecipe catch block, failHard must appear.
    const idx = SRC.indexOf("resolveRecipe(recipeName");
    expect(idx).toBeGreaterThan(-1);
    const slice = SRC.slice(idx, idx + 300);
    expect(slice).toMatch(/failHard\s*\(/);
  });

  it("uses failHard for resolveRailPackages failure", () => {
    const idx = SRC.indexOf("resolveRailPackages(");
    expect(idx).toBeGreaterThan(-1);
    const slice = SRC.slice(idx, idx + 300);
    expect(slice).toMatch(/failHard\s*\(/);
  });

  it("uses failHard for missing rail cluster(s)", () => {
    // The missing.length > 0 branch must use failHard.
    const idx = SRC.indexOf("missing rail cluster(s)");
    expect(idx).toBeGreaterThan(-1);
    // Check the surrounding context for failHard
    const slice = SRC.slice(Math.max(0, idx - 100), idx + 200);
    expect(slice).toMatch(/failHard\s*\(/);
  });

  it("uses failHard for resolveModel failure", () => {
    const idx = SRC.indexOf("resolveModel(");
    expect(idx).toBeGreaterThan(-1);
    const slice = SRC.slice(idx, idx + 300);
    expect(slice).toMatch(/failHard\s*\(/);
  });

  it("uses failHard for invalid --topology-overlay JSON", () => {
    const idx = SRC.indexOf("topology-overlay invalid JSON");
    expect(idx).toBeGreaterThan(-1);
    const slice = SRC.slice(Math.max(0, idx - 50), idx + 200);
    expect(slice).toMatch(/failHard\s*\(/);
  });

  it("uses failHard for setHabitat failure", () => {
    const idx = SRC.indexOf("setHabitat failed");
    expect(idx).toBeGreaterThan(-1);
    const slice = SRC.slice(Math.max(0, idx - 50), idx + 100);
    expect(slice).toMatch(/failHard\s*\(/);
  });
});

describe("recipe-loader.ts — non-fatal paths kept as warnings (issue #173)", () => {
  it("keeps skill resolution failure as warning (non-fatal)", () => {
    // The skills catch block must use "warning" severity, not failHard.
    const idx = SRC.indexOf("resolveSkills(");
    expect(idx).toBeGreaterThan(-1);
    // Find the catch block after resolveSkills
    const slice = SRC.slice(idx, idx + 400);
    expect(slice).toMatch(/"warning"/);
    // And must NOT use failHard in the skills catch
    // Find the catch after resolveSkills specifically
    const catchIdx = slice.indexOf("} catch");
    const catchSlice = slice.slice(catchIdx, catchIdx + 200);
    expect(catchSlice).not.toMatch(/failHard\s*\(/);
  });

  it("missing API key path uses warning (non-fatal)", () => {
    expect(SRC).toMatch(/no API key available.*warning|warning.*no API key available/s);
  });

  it("unknown model path uses warning (non-fatal)", () => {
    expect(SRC).toMatch(/not found in registry.*warning|warning.*not found in registry/s);
  });

  it("invalid tool names path uses warning (non-fatal)", () => {
    expect(SRC).toMatch(/tools not available.*warning|warning.*tools not available/s);
  });
});
