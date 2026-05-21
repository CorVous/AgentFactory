/**
 * mesh-spawn.test.ts — source-level + injected-spawner assertions for the
 * new mesh-spawn extension (packages/engine/agent/extensions/mesh-spawn.ts).
 *
 * Tests verify:
 *   1. Source-level: imports peer-spawn, uses buildRecipeChildArgv.
 *   2. mesh_spawn param validation: allowlist enforcement, recipe-not-found.
 *   3. mesh_kill: not-found case.
 *
 * Contract: pure file-content and unit assertions; no jiti, no pi runtime, no
 * live child processes. Hermetic by construction.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "mesh-spawn.ts"), "utf8");

// ── Source-level assertions ─────────────────────────────────────────────────

describe("mesh-spawn.ts — source-level", () => {
  it("imports from peer-spawn", () => {
    expect(SRC).toMatch(/from.*peer-spawn/);
  });

  it("imports runMeshSpawn from peer-spawn", () => {
    expect(SRC).toMatch(/runMeshSpawn/);
  });

  it("uses buildRecipeChildArgv", () => {
    expect(SRC).toMatch(/buildRecipeChildArgv/);
  });

  it("imports buildRecipeChildArgv from child-spawn", () => {
    expect(SRC).toMatch(/buildRecipeChildArgv.*child-spawn|child-spawn.*buildRecipeChildArgv/s);
  });

  it("registers mesh_spawn tool", () => {
    expect(SRC).toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']mesh_spawn["']/s);
  });

  it("registers mesh_kill tool", () => {
    expect(SRC).toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']mesh_kill["']/s);
  });

  it("uses __pi_mesh_spawn_nodes__ registry on globalThis", () => {
    expect(SRC).toMatch(/__pi_mesh_spawn_nodes__/);
  });

  it("handles session_shutdown to cascade-kill all nodes", () => {
    expect(SRC).toMatch(/session_shutdown/);
  });

  it("uses serializeHabitatOverlay from peer-spawn", () => {
    expect(SRC).toMatch(/serializeHabitatOverlay/);
  });

  it("does NOT register mesh_stop or mesh_nodes (old names)", () => {
    expect(SRC).not.toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']mesh_stop["']/s);
    expect(SRC).not.toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']mesh_nodes["']/s);
  });

  it("checks recipe allowlist against getHabitat().spawns", () => {
    expect(SRC).toMatch(/spawns/);
    expect(SRC).toMatch(/recipe_not_allowed/);
  });

  it("checks recipe-exists before spawning", () => {
    expect(SRC).toMatch(/recipe_not_found/);
  });

  it("sends a shutdown envelope via sendOverBus on mesh_kill", () => {
    expect(SRC).toMatch(/makeShutdownEnvelope/);
    expect(SRC).toMatch(/sendOverBus/);
  });

  it("uses task via --task (not -p) for long-lived workers", () => {
    // productionSpawnWorker must pass task via the `task:` option to
    // buildRecipeChildArgv, NOT via printPrompt.
    expect(SRC).toMatch(/task:\s*args\.task|task:.*args\.task/s);
    // Must NOT pass task as printPrompt for long-lived workers
    expect(SRC).not.toMatch(/printPrompt\s*:\s*args\.task/);
  });

  it("validates groups param: rejects names starting with '_'", () => {
    // Must check for reserved group names
    expect(SRC).toMatch(/reserved_group_name|starts.*with.*_|startsWith.*_/);
  });

  it("groups param is validated before spawning", () => {
    // Group validation must come before runMeshSpawn
    const validationIdx = SRC.indexOf("reserved_group_name");
    const runMeshIdx = SRC.indexOf("runMeshSpawn({");
    expect(validationIdx).toBeGreaterThan(-1);
    expect(runMeshIdx).toBeGreaterThan(-1);
    expect(validationIdx).toBeLessThan(runMeshIdx);
  });

  it("passes groups to runMeshSpawn", () => {
    // The call to runMeshSpawn must include groups:
    const runMeshIdx = SRC.indexOf("runMeshSpawn({");
    const afterRunMesh = SRC.slice(runMeshIdx, runMeshIdx + 400);
    expect(afterRunMesh).toMatch(/groups:/);
  });

  it("groups param description does NOT say 'ignored for now'", () => {
    expect(SRC).not.toMatch(/ignored for now/);
  });
});
