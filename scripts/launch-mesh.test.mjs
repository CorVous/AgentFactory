// launch-mesh.test.mjs — source-level assertions for the --inherit-pty peerArgs
// change in launch-mesh.mjs (Slice 5: replace PI_MESH_PEER env var).
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

  it("peerEnv still includes PI_AGENT_NAME and PI_AGENT_BUS_ROOT", () => {
    // These env vars carry peer identity information and must remain.
    expect(SRC).toMatch(/PI_AGENT_NAME/);
    expect(SRC).toMatch(/PI_AGENT_BUS_ROOT/);
  });
});
