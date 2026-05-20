/**
 * launcher-bridge.test.ts — source-level assertions for the launcher-bridge
 * extension post Slice 5 (replace PI_MESH_PEER env var with --inherit-pty flag)
 * and Slice 6 (replace AGENT_DEBUG env var with getHabitat().debug).
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
});

describe("launcher-bridge.ts — AGENT_DEBUG env var replaced with getHabitat().debug (Slice 6)", () => {
  it("does not reference process.env.AGENT_DEBUG anywhere", () => {
    expect(SRC).not.toMatch(/process\.env\.AGENT_DEBUG/);
  });

  it("debug branch uses getHabitat().debug === true", () => {
    // The AGENT_DEBUG notify branches were replaced with getHabitat().debug === true.
    expect(SRC).toMatch(/getHabitat\(\)\.debug\s*===\s*true/);
  });
});
