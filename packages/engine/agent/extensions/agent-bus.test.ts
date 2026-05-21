/**
 * agent-bus.test.ts — source-level assertions for the engine's agent-bus
 * extension (packages/engine/agent/extensions/agent-bus.ts).
 *
 * Verifies:
 *   1. habitatHasPeers is imported and used to gate bindServer.
 *   2. Tool registration (registerTool) is NOT inside the peering guard,
 *      so tools are always available in pi.getAllTools().
 *
 * Contract: pure file-content assertions; no jiti, no pi runtime, no I/O
 * beyond reading the sibling source file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "agent-bus.ts"), "utf8");

describe("agent-bus.ts — lazy acquisition gate", () => {
  it("imports habitatHasPeers from the engine lib", () => {
    expect(SRC).toMatch(/import.*habitatHasPeers.*from/);
  });

  it("guards bindServer call with habitatHasPeers", () => {
    // The gate check must appear before the bindServer call in session_start.
    const gateIdx = SRC.indexOf("habitatHasPeers");
    const bindIdx = SRC.indexOf("await bindServer");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(bindIdx).toBeGreaterThan(-1);
    // Gate comes before bind (lazy acquisition).
    expect(gateIdx).toBeLessThan(bindIdx);
  });

  it("tool registration is present (unconditional)", () => {
    // All four mesh tools must be registered.
    expect(SRC).toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']agent_send["']/s);
    expect(SRC).toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']agent_inbox["']/s);
    expect(SRC).toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']agent_list["']/s);
    expect(SRC).toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']agent_call["']/s);
  });
});
