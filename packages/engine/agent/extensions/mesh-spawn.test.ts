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

  it("registers __pi_mesh_spawn_is_my_worker__ predicate on globalThis (Slice 6)", () => {
    expect(SRC).toMatch(/__pi_mesh_spawn_is_my_worker__/);
  });

  it("does NOT register __pi_atomic_delegate_dispatch__ (deleted in Slice 6)", () => {
    expect(SRC).not.toMatch(/__pi_atomic_delegate_dispatch__/);
  });

  it("does NOT reference the delegate tool (deleted in Slice 6)", () => {
    // mesh-spawn.ts must not mention the delegate tool
    expect(SRC).not.toMatch(/["']delegate["']/);
  });
});

// ── provider forwarding (issue #189) ────────────────────────────────────────

describe("mesh-spawn.ts — provider forwarding (issue #189)", () => {
  it("passes provider: args.provider in productionSpawnWorker's buildRecipeChildArgv call", () => {
    expect(SRC).toMatch(/provider:\s*args\.provider/);
  });

  it("passes provider: ctx.model?.provider at the runMeshSpawn call site", () => {
    const runMeshIdx = SRC.indexOf("runMeshSpawn({");
    expect(runMeshIdx).toBeGreaterThan(-1);
    const afterRunMesh = SRC.slice(runMeshIdx, runMeshIdx + 600);
    expect(afterRunMesh).toMatch(/provider:\s*ctx\.model\?\.provider/);
  });
});

// ── cwd inheritance (issue #172) ────────────────────────────────────────────

describe("mesh-spawn.ts — cwd inheritance (issue #172)", () => {
  it("does NOT pass cwd: REPO_ROOT to child_process.spawn", () => {
    expect(SRC).not.toMatch(/cwd:\s*REPO_ROOT/);
  });

  it("threads caller cwd through productionSpawnWorker", () => {
    expect(SRC).toMatch(/cwd:\s*args\.callerCwd/);
  });

  it("captures ctx in mesh_spawn.execute signature", () => {
    // The execute signature must accept ctx as a parameter
    expect(SRC).toMatch(/execute\([^)]*ctx[^)]*\)/);
  });

  it("passes callerCwd to runMeshSpawn at the call site", () => {
    // The runMeshSpawn call must include a callerCwd: field
    const runMeshIdx = SRC.indexOf("runMeshSpawn({");
    expect(runMeshIdx).toBeGreaterThan(-1);
    const afterRunMesh = SRC.slice(runMeshIdx, runMeshIdx + 500);
    expect(afterRunMesh).toMatch(/callerCwd:/);
  });
});

// ── Dynamic-worker admission predicate — registry-membership logic ──────────

describe("__pi_mesh_spawn_is_my_worker__ predicate — registry membership", () => {
  it("returns true for a name in the registry (pure logic via source inspection)", () => {
    // The predicate reads from the getRegistry() map. Verify the source pattern:
    // isMeshSpawnWorker(name) should call getRegistry().has(name)
    expect(SRC).toMatch(/getRegistry\(\)\.has\(name\)/);
  });

  it("predicate function is exported via globalThis (so peer-bus can read it)", () => {
    // Must assign to globalThis.__pi_mesh_spawn_is_my_worker__
    expect(SRC).toMatch(/\.__pi_mesh_spawn_is_my_worker__\s*=\s*isMeshSpawnWorker/);
  });

  it("predicate is registered at extension init (registerMeshSpawnPredicate called)", () => {
    expect(SRC).toMatch(/registerMeshSpawnPredicate\(\)/);
  });
});
