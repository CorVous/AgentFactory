/**
 * atomic-delegate.test.ts — source-level + injected-spawner assertions for the
 * Slice 6 repoint of atomic-delegate.ts from `node run-agent.mjs` to `pi --recipe`.
 *
 * Slice 6 / ADR-0010: children are now spawned as `pi --recipe <recipe>` via
 * buildRecipeChildArgv from the engine lib. This test verifies:
 *   1. The source file no longer references run-agent.mjs or RUNNER_PATH.
 *   2. The source imports buildRecipeChildArgv from the engine lib.
 *   3. The argv produced by productionSpawnWorker contains --recipe, -p,
 *      --peer-name, and --topology-overlay (via buildRecipeChildArgv).
 *
 * Contract: pure file-content and unit assertions; no jiti, no pi runtime, no live
 * child processes. Hermetic by construction.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRecipeChildArgv, resolvePiBin } from "../../../packages/engine/agent/lib/child-spawn.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "atomic-delegate.ts"), "utf8");

describe("atomic-delegate.ts — Slice 6 pi --recipe repoint (source-level)", () => {
  it("does not reference run-agent.mjs as a spawn target", () => {
    // RUNNER_PATH was the old path; Slice 6 drops it.
    expect(SRC).not.toMatch(/RUNNER_PATH/);
    expect(SRC).not.toMatch(/run-agent\.mjs/);
  });

  it("imports buildRecipeChildArgv from the engine lib", () => {
    expect(SRC).toMatch(/buildRecipeChildArgv/);
    expect(SRC).toMatch(/child-spawn/);
  });

  it("imports resolvePiBin and resolveRepoRoot from the engine lib", () => {
    expect(SRC).toMatch(/resolvePiBin/);
    expect(SRC).toMatch(/resolveRepoRoot/);
  });

  it("no longer sets RUNNER_PATH or AGENTS_DIR from run-agent.mjs", () => {
    // RUNNER_PATH was deleted in Slice 6.
    expect(SRC).not.toMatch(/RUNNER_PATH/);
  });

  it("uses PI_BIN resolved from the engine helper", () => {
    // PI_BIN is computed via resolvePiBin(REPO_ROOT).
    expect(SRC).toMatch(/PI_BIN/);
  });

  it("passes printPrompt (not -p inline) to buildRecipeChildArgv for the task", () => {
    // In Slice 6, the task is passed as printPrompt option to buildRecipeChildArgv,
    // not as a bare "-p" pushed into an inline array.
    expect(SRC).toMatch(/printPrompt\s*:\s*args\.task/);
  });

  it("passes topologyOverlay as a JSON-serialised string option", () => {
    expect(SRC).toMatch(/topologyOverlay\s*:/);
    expect(SRC).toMatch(/JSON\.stringify\s*\(\s*args\.habitatOverlay\s*\)/);
  });

  it("passes agentName from args.workerName to --peer-name (via buildRecipeChildArgv)", () => {
    // Slice 6: agent identity is --peer-name, not --agent-name.
    expect(SRC).toMatch(/agentName\s*:\s*args\.workerName/);
    // Old passthrough pattern should not appear.
    expect(SRC).not.toMatch(/"--agent-name"/);
  });
});

describe("buildRecipeChildArgv — argv contains required flags for atomic-delegate use", () => {
  // These tests verify the argv produced for a typical worker spawn includes all
  // the flags that atomic-delegate needs to pass to the child pi process.

  const FAKE_PI_BIN = "/fake/node_modules/.bin/pi";

  it("argv contains --recipe followed by the recipe name", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "deferred-writer",
      sandbox: "/tmp/worker-scratch",
      busRoot: "/tmp/bus",
      agentName: "cottontail-worker",
      topologyOverlay: JSON.stringify({ supervisor: "boss", agents: [] }),
      printPrompt: "draft hello.txt with hi",
    });
    const idx = argv.indexOf("--recipe");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("deferred-writer");
  });

  it("argv contains -p followed by the task/printPrompt", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "deferred-writer",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      agentName: "worker",
      printPrompt: "draft hello.txt",
    });
    const idx = argv.indexOf("-p");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("draft hello.txt");
  });

  it("argv contains --peer-name followed by the worker name", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "deferred-writer",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      agentName: "cottontail-writer",
    });
    const idx = argv.indexOf("--peer-name");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("cottontail-writer");
  });

  it("argv contains --topology-overlay followed by the JSON string", () => {
    const overlay = JSON.stringify({ supervisor: "boss", submitTo: "boss", agents: [] });
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "deferred-writer",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      agentName: "worker",
      topologyOverlay: overlay,
    });
    const idx = argv.indexOf("--topology-overlay");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe(overlay);
  });

  it("resolvePiBin produces the expected path for a given repo root", () => {
    const bin = resolvePiBin("/some/project");
    expect(bin).toBe("/some/project/node_modules/.bin/pi");
  });
});
