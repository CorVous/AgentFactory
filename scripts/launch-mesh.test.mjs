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
  it('includes the "--inherit-pty" literal string in the peerArgs array', () => {
    expect(SRC).toMatch(/"--inherit-pty"/);
  });

  it('"--inherit-pty" appears in the peerArgs construction block (before the "--" separator)', () => {
    // peerArgs is built as an array literal; "--inherit-pty" must appear
    // as a standalone element, before the "--" passthrough separator.
    const peerArgsStart = SRC.indexOf("peerArgs");
    expect(peerArgsStart).toBeGreaterThanOrEqual(0);
    // Find "--inherit-pty" and "--" within that block and verify order.
    const inheritPtyPos = SRC.indexOf('"--inherit-pty"', peerArgsStart);
    const passthroughPos = SRC.indexOf('"--",', peerArgsStart);
    // Both must exist
    expect(inheritPtyPos).toBeGreaterThanOrEqual(0);
    expect(passthroughPos).toBeGreaterThanOrEqual(0);
    // "--inherit-pty" must come before the "--" separator
    expect(inheritPtyPos).toBeLessThan(passthroughPos);
  });

  it("does not set PI_MESH_PEER in peerEnv", () => {
    expect(SRC).not.toMatch(/PI_MESH_PEER/);
  });

  it("does not set PI_AGENT_NAME in peerEnv (Slice 6: identity flows via CLI flags)", () => {
    // After Slice 6, identity is passed via --agent-name in peerArgs, not env vars.
    expect(SRC).not.toMatch(/PI_AGENT_NAME/);
  });

  it("does not set PI_AGENT_BUS_ROOT in peerEnv (Slice 6: bus root flows via --agent-bus)", () => {
    // After Slice 6, bus root is passed via --agent-bus in peerArgs, not env vars.
    expect(SRC).not.toMatch(/PI_AGENT_BUS_ROOT/);
  });
});
