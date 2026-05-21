/**
 * launcher-bridge.test.ts — source-level assertions for the engine's
 * launcher-bridge extension (packages/engine/agent/extensions/launcher-bridge.ts).
 *
 * Verifies:
 *   1. PI_MESH_PEER env var is not referenced (removed in Slice 5).
 *   2. client.connect(busRoot, 1000) is still called for the launcher socket.
 *   3. AGENT_DEBUG env var is not referenced (replaced with getHabitat().debug).
 *   4. Lazy acquisition gate: habitatHasPeers is imported and guards the connect.
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
    expect(SRC).toMatch(/client\.connect\s*\(\s*busRoot\s*,\s*1000\s*\)/);
  });

  it("file-header comment references the peer template, not PI_MESH_PEER", () => {
    expect(SRC).toMatch(/peer template|peer\.yaml/i);
    expect(SRC).not.toMatch(/PI_MESH_PEER/);
  });
});

describe("launcher-bridge.ts — AGENT_DEBUG env var replaced with getHabitat().debug (Slice 6)", () => {
  it("does not reference process.env.AGENT_DEBUG anywhere", () => {
    expect(SRC).not.toMatch(/process\.env\.AGENT_DEBUG/);
  });

  it("debug branch uses getHabitat().debug === true", () => {
    expect(SRC).toMatch(/getHabitat\(\)\.debug\s*===\s*true/);
  });
});

describe("launcher-bridge.ts — lazy acquisition gate (Slice 5)", () => {
  it("imports habitatHasPeers from the engine lib", () => {
    expect(SRC).toMatch(/import.*habitatHasPeers.*from/);
  });

  it("guards launcher connect with habitatHasPeers", () => {
    // The gate must appear in the session_start handler.
    expect(SRC).toMatch(/habitatHasPeers\s*\(/);
  });

  it("resolves launcher-socket.mjs from engine lib (not scripts/_lib)", () => {
    // The path must point to ../lib/launcher-socket.mjs, not ../../../scripts/_lib
    expect(SRC).toMatch(/\.\.\/lib\/launcher-socket\.mjs/);
    expect(SRC).not.toMatch(/scripts\/_lib\/launcher-socket\.mjs/);
  });
});
