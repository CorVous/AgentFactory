/**
 * recipe-loader.test.ts — source-level assertions for the engine's
 * recipe-loader extension (packages/engine/agent/extensions/recipe-loader.ts).
 *
 * Verifies:
 *   1. The failHard helper exists, writes to stderr, exits the process (so the
 *      abort survives the SDK's ExtensionRunner.emit() try/catch), and throws
 *      (unreachable, retained for the `never` contract if process.exit is stubbed).
 *   2. Fatal error paths (resolveRecipe, resolveRailPackages, missing clusters,
 *      resolveModel, topology-overlay JSON parse, setHabitat, missing API key,
 *      unknown model) use failHard — so ALL 8 call sites actually abort.
 *   3. Non-fatal paths (skill resolution, invalid tool names) still use
 *      "warning" and do NOT use failHard.
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
    const failHardBody = SRC.slice(failHardIdx, failHardIdx + 700);
    expect(failHardBody).toMatch(/throw new Error/);
  });

  it("failHard exits the process so the abort survives the SDK catch", () => {
    const idx = SRC.indexOf("function failHard");
    expect(idx).toBeGreaterThan(-1);
    const slice = SRC.slice(idx, idx + 500);
    expect(slice).toMatch(/process\.exit\(\s*1\s*\)/);
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

describe("recipe-loader.ts — repo-local search paths (issue #170)", () => {
  it("getRecipeDirs includes <cwd>/pi-sandbox/agents", () => {
    const idx = SRC.indexOf("function getRecipeDirs(");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 400);
    expect(body).toMatch(/path\.join\(cwd,\s*["']pi-sandbox["'],\s*["']agents["']\)/);
  });

  it("getRecipeDirs includes <cwd>/agents", () => {
    const idx = SRC.indexOf("function getRecipeDirs(");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 400);
    // Must contain "agents" as a standalone segment (not only via pi-sandbox/agents)
    expect(body).toMatch(/path\.join\(cwd,\s*["']agents["']\)/);
  });

  it("getTemplateDirs includes <cwd>/pi-sandbox/templates", () => {
    const idx = SRC.indexOf("function getTemplateDirs(");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 400);
    expect(body).toMatch(/path\.join\(cwd,\s*["']pi-sandbox["'],\s*["']templates["']\)/);
  });

  it("getTemplateDirs includes <cwd>/templates", () => {
    const idx = SRC.indexOf("function getTemplateDirs(");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 400);
    expect(body).toMatch(/path\.join\(cwd,\s*["']templates["']\)/);
  });

  it("getTemplateDirs does NOT include <cwd>/agents", () => {
    const idx = SRC.indexOf("function getTemplateDirs(");
    expect(idx).toBeGreaterThan(-1);
    // Capture just the getTemplateDirs body (stop before the next export function)
    const afterFn = SRC.slice(idx, idx + 400);
    const bodyEnd = afterFn.indexOf("export function", 1);
    const body = bodyEnd > 0 ? afterFn.slice(0, bodyEnd) : afterFn;
    // The body should not reference "agents" (that's for getRecipeDirs)
    expect(body).not.toMatch(/["']agents["']/);
  });

  it("getSkillDirs includes <cwd>/pi-sandbox/skills", () => {
    const idx = SRC.indexOf("function getSkillDirs(");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 400);
    expect(body).toMatch(/path\.join\(cwd,\s*["']pi-sandbox["'],\s*["']skills["']\)/);
  });

  it("getSkillDirs includes <cwd>/skills", () => {
    const idx = SRC.indexOf("function getSkillDirs(");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 400);
    expect(body).toMatch(/path\.join\(cwd,\s*["']skills["']\)/);
  });

  it("project-local precedence preserved: .pi/recipes appears before pi-sandbox/agents", () => {
    const idx = SRC.indexOf("function getRecipeDirs(");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 400);
    const projectLocalIdx = body.indexOf('".pi"');
    const altIdx = body.indexOf("'.pi'");
    const piIdx = projectLocalIdx !== -1 ? projectLocalIdx : altIdx;
    expect(piIdx).toBeGreaterThan(-1);
    // Find pi-sandbox/agents as separate path.join args in the source
    const sandboxMatch = /path\.join\(cwd,\s*["']pi-sandbox["'],\s*["']agents["']\)/.exec(body);
    expect(sandboxMatch).not.toBeNull();
    const sandboxIdx = sandboxMatch!.index;
    expect(piIdx).toBeLessThan(sandboxIdx);
  });

  it("repo-local before bundled: pi-sandbox/agents appears before BUNDLED_RECIPES_DIR", () => {
    const idx = SRC.indexOf("function getRecipeDirs(");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 400);
    // Find pi-sandbox/agents as separate path.join args in the source
    const sandboxMatch = /path\.join\(cwd,\s*["']pi-sandbox["'],\s*["']agents["']\)/.exec(body);
    expect(sandboxMatch).not.toBeNull();
    const sandboxIdx = sandboxMatch!.index;
    const bundledIdx = body.indexOf("BUNDLED_RECIPES_DIR");
    expect(bundledIdx).toBeGreaterThan(-1);
    expect(sandboxIdx).toBeLessThan(bundledIdx);
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

  it("uses failHard for missing API key (setModel returned false)", () => {
    const idx = SRC.indexOf("no API key available");
    expect(idx).toBeGreaterThan(-1);
    const slice = SRC.slice(Math.max(0, idx - 100), idx + 150);
    expect(slice).toMatch(/failHard\s*\(/);
    expect(slice).not.toMatch(/"warning"/);
  });

  it("uses failHard for unknown model (not found in registry)", () => {
    const idx = SRC.indexOf("not found in registry");
    expect(idx).toBeGreaterThan(-1);
    const slice = SRC.slice(Math.max(0, idx - 100), idx + 150);
    expect(slice).toMatch(/failHard\s*\(/);
    expect(slice).not.toMatch(/"warning"/);
  });

  it("invalid tool names path uses warning (non-fatal)", () => {
    expect(SRC).toMatch(/tools not available.*warning|warning.*tools not available/s);
  });
});
