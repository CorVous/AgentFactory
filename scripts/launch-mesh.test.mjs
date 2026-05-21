// launch-mesh.test.mjs — source-level assertions for the --inherit-pty peerArgs
// change in launch-mesh.mjs (Slice 5: replace PI_MESH_PEER env var) and
// Slice 6 env-var elimination (drop PI_AGENT_NAME, PI_AGENT_BUS_ROOT from peerEnv).
//
// Contract: pure file-content assertions; no exec, no model API calls, no network.
// Hermetic by construction — reads the sibling source file and pattern-matches.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "launch-mesh.mjs"), "utf8");

describe("launch-mesh.mjs — --inherit-pty in peerArgs", () => {
  it('includes the "--inherit-pty" literal string (passed to buildRecipeChildArgv)', () => {
    // Slice 6: inherited-pty is now passed via the inheritPty option to buildRecipeChildArgv.
    expect(SRC).toMatch(/inheritPty/);
  });

  it("does not set PI_MESH_PEER in peerEnv", () => {
    expect(SRC).not.toMatch(/PI_MESH_PEER/);
  });

  it("does not set PI_AGENT_NAME in peerEnv (Slice 6: identity flows via CLI flags)", () => {
    // After Slice 6, identity is passed via --peer-name via buildRecipeChildArgv, not env vars.
    expect(SRC).not.toMatch(/PI_AGENT_NAME/);
  });

  it("does not set PI_AGENT_BUS_ROOT in peerEnv (Slice 6: bus root flows via --agent-bus)", () => {
    // After Slice 6, bus root is passed via --agent-bus via buildRecipeChildArgv, not env vars.
    expect(SRC).not.toMatch(/PI_AGENT_BUS_ROOT/);
  });
});

describe("launch-mesh.mjs — Slice 6 pi --recipe repoint", () => {
  it("does not reference run-agent.mjs as RUNNER or spawn target", () => {
    // Slice 6: children are now spawned as pi --recipe, not via node run-agent.mjs.
    expect(SRC).not.toMatch(/RUNNER\s*=/);
    expect(SRC).not.toMatch(/run-agent\.mjs/);
  });

  it("imports buildRecipeChildArgv from the engine lib", () => {
    expect(SRC).toMatch(/buildRecipeChildArgv/);
    expect(SRC).toMatch(/child-spawn\.mjs/);
  });

  it("uses buildRecipeChildArgv to build peerArgs (not an inline array)", () => {
    // peerArgs should be assigned from a buildRecipeChildArgv call, not from a literal array.
    expect(SRC).toMatch(/buildRecipeChildArgv\s*\(/);
  });

  it("passes --peer-name via buildRecipeChildArgv (instanceName field, not --agent-name)", () => {
    // Slice 1 rename: agentName → instanceName; buildRecipeChildArgv maps instanceName → --peer-name.
    expect(SRC).toMatch(/instanceName\s*:\s*name/);
    // Old --agent-name passthrough pattern should not appear in the peerArgs construction.
    expect(SRC).not.toMatch(/"--agent-name"/);
  });

  it("does not reference --topology-overlay as an inline peerArgs push (delegated to buildRecipeChildArgv)", () => {
    // The topology overlay is now passed via the topologyOverlay option.
    expect(SRC).toMatch(/topologyOverlay/);
  });
});
