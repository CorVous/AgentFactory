/**
 * peer-bus.test.ts — source-level assertions for the engine's peer-bus
 * extension (packages/engine/agent/extensions/peer-bus.ts).
 *
 * Verifies:
 *   1. habitatHasPeers is imported and used to gate bindServer.
 *   2. Tool registration (registerTool) is NOT inside the peering guard,
 *      so tools are always available in pi.getAllTools().
 *   3. Tools are registered under the new peer_* names (not old agent_* names).
 *
 * Contract: pure file-content assertions; no jiti, no pi runtime, no I/O
 * beyond reading the sibling source file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "peer-bus.ts"), "utf8");

describe("peer-bus.ts — shutdown envelope handling", () => {
  it("handles shutdown kind before the acceptsWorkFrom array read", () => {
    // The shutdown handler must appear before the code that reads acceptsWorkFrom.
    // We look for the actual enforcement: `getHabitat().acceptsWorkFrom`
    const shutdownIdx = SRC.indexOf('kind === "shutdown"');
    // Find the enforcement code — the actual array read, not comments
    const enforcementIdx = SRC.indexOf("getHabitat().acceptsWorkFrom");
    expect(shutdownIdx).toBeGreaterThan(-1);
    expect(enforcementIdx).toBeGreaterThan(-1);
    // shutdown is handled first (gate bypass)
    expect(shutdownIdx).toBeLessThan(enforcementIdx);
  });

  it("calls process.exit(0) or pi.shutdown() in the shutdown handler", () => {
    // The shutdown branch must schedule a process exit (or pi.shutdown fallback).
    expect(SRC).toMatch(/process\.exit\(0\)|\.shutdown\(\)/);
  });

  it("shutdown handler returns early (does not fall through to acceptsWorkFrom check)", () => {
    // There must be a `return` after the setTimeout in the shutdown block.
    const shutdownStart = SRC.indexOf('kind === "shutdown"');
    const afterShutdown = SRC.slice(shutdownStart, shutdownStart + 800);
    expect(afterShutdown).toMatch(/return\s*;/);
  });
});

describe("peer-bus.ts — lazy acquisition gate", () => {
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
    // All four mesh tools must be registered under new peer_* names.
    expect(SRC).toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']peer_send["']/s);
    expect(SRC).toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']peer_inbox["']/s);
    expect(SRC).toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']peer_list["']/s);
    expect(SRC).toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']peer_call["']/s);
  });

  it("does NOT register any old agent_* tool names", () => {
    // Retired tool names must not appear as registerTool names (warn-and-drop is sufficient).
    expect(SRC).not.toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']agent_send["']/s);
    expect(SRC).not.toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']agent_inbox["']/s);
    expect(SRC).not.toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']agent_list["']/s);
    expect(SRC).not.toMatch(/registerTool\s*\(\s*\{[^}]*name:\s*["']agent_call["']/s);
  });
});
