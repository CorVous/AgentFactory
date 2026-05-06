/**
 * launcher-bridge.test.ts — source-level assertions for the launcher-bridge
 * extension post Slice 5 (replace PI_MESH_PEER env var with --inherit-pty flag).
 *
 * Contract: pure file-content assertions; no jiti, no pi runtime, no I/O
 * beyond reading the sibling source file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "launcher-bridge.ts"), "utf8");

describe("launcher-bridge.ts — PI_MESH_PEER removal (Slice 5)", () => {
  it("does not reference PI_MESH_PEER anywhere", () => {
    expect(SRC).not.toMatch(/PI_MESH_PEER/);
  });

  it("still calls client.connect(busRoot, 1000) for the launcher socket", () => {
    // The connect call is the core side-effect that must survive the refactor.
    expect(SRC).toMatch(/client\.connect\s*\(\s*busRoot\s*,\s*1000\s*\)/);
  });

  it("file-header comment references the peer template, not PI_MESH_PEER", () => {
    // The old header said "Auto-loaded by run-agent.mjs when PI_MESH_PEER=1".
    // After Slice 5 it must reference the peer template instead.
    expect(SRC).toMatch(/peer template|peer\.yaml/i);
    // Confirm PI_MESH_PEER is not present in the header (or anywhere).
    expect(SRC).not.toMatch(/PI_MESH_PEER/);
  });

  it("AGENT_DEBUG=1 branch for standalone mode is still present", () => {
    // The AGENT_DEBUG notify branches (connected / standalone) should survive.
    expect(SRC).toMatch(/AGENT_DEBUG/);
  });
});
