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

  it("guards transport.listen call with habitatHasPeers", () => {
    // The gate check must appear before the transport bind/listen call in session_start.
    const gateIdx = SRC.indexOf("habitatHasPeers");
    // Accept either the old "await bindServer" or the new "transport.listen" pattern.
    const bindIdx = SRC.indexOf("await bindServer") !== -1
      ? SRC.indexOf("await bindServer")
      : SRC.indexOf(".listen(");
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

// ── Slice 3: cohort cache + mesh-update + fan-out + group-ref rejection ─────

describe("peer-bus.ts — Slice 3 source-level assertions", () => {
  it("imports ingestMeshUpdate from cohort-tracker", () => {
    expect(SRC).toMatch(/import.*ingestMeshUpdate.*from.*cohort-tracker/s);
  });

  it("imports expandGroupRef from cohort-tracker", () => {
    expect(SRC).toMatch(/import.*expandGroupRef.*from.*cohort-tracker/s);
  });

  it("imports parseRef from peer-spawn", () => {
    expect(SRC).toMatch(/import.*parseRef.*from.*peer-spawn/s);
  });

  it("BusState has cohortCache field", () => {
    expect(SRC).toMatch(/cohortCache\s*:/);
  });

  it("BusState has selfGroups field", () => {
    expect(SRC).toMatch(/selfGroups\s*:/);
  });

  it("BusState has spawnerName field", () => {
    expect(SRC).toMatch(/spawnerName\s*:/);
  });

  it("mesh-update branch is handled before the acceptsWorkFrom gate", () => {
    const meshUpdateIdx = SRC.indexOf('kind === "mesh-update"');
    const enforcementIdx = SRC.indexOf("getHabitat().acceptsWorkFrom");
    expect(meshUpdateIdx).toBeGreaterThan(-1);
    expect(enforcementIdx).toBeGreaterThan(-1);
    expect(meshUpdateIdx).toBeLessThan(enforcementIdx);
  });

  it("mesh-update branch is handled before the shutdown branch", () => {
    const meshUpdateIdx = SRC.indexOf('kind === "mesh-update"');
    const shutdownIdx = SRC.indexOf('kind === "shutdown"');
    expect(meshUpdateIdx).toBeGreaterThan(-1);
    expect(shutdownIdx).toBeGreaterThan(-1);
    expect(meshUpdateIdx).toBeLessThan(shutdownIdx);
  });

  it("mesh-update branch calls ingestMeshUpdate", () => {
    const meshUpdateIdx = SRC.indexOf('kind === "mesh-update"');
    const afterMeshUpdate = SRC.slice(meshUpdateIdx, meshUpdateIdx + 300);
    expect(afterMeshUpdate).toMatch(/ingestMeshUpdate/);
  });

  it("mesh-update branch returns early (not surfaced to inbox/model)", () => {
    const meshUpdateIdx = SRC.indexOf('kind === "mesh-update"');
    const afterMeshUpdate = SRC.slice(meshUpdateIdx, meshUpdateIdx + 400);
    expect(afterMeshUpdate).toMatch(/return\s*;/);
  });

  it("peer_send uses parseRef to check the `to` field", () => {
    // Find peer_send execute block and check parseRef is called
    const peerSendIdx = SRC.indexOf("name: \"peer_send\"");
    const afterPeerSend = SRC.slice(peerSendIdx, peerSendIdx + 3000);
    expect(afterPeerSend).toMatch(/parseRef/);
  });

  it("peer_send calls expandGroupRef for group refs", () => {
    const peerSendIdx = SRC.indexOf("name: \"peer_send\"");
    const afterPeerSend = SRC.slice(peerSendIdx, peerSendIdx + 3000);
    expect(afterPeerSend).toMatch(/expandGroupRef/);
  });

  it("peer_call rejects group refs with a clear error message", () => {
    const peerCallIdx = SRC.indexOf("name: \"peer_call\"");
    const afterPeerCall = SRC.slice(peerCallIdx, peerCallIdx + 2000);
    expect(afterPeerCall).toMatch(/group.*ref.*not.*supported|group_ref_not_allowed/i);
  });

  it("peer_call uses parseRef to guard against group refs", () => {
    const peerCallIdx = SRC.indexOf("name: \"peer_call\"");
    const afterPeerCall = SRC.slice(peerCallIdx, peerCallIdx + 2000);
    expect(afterPeerCall).toMatch(/parseRef/);
  });

  it("references getCohortLookupHook or __pi_cohort_lookup__ for unknown-sender seam", () => {
    expect(SRC).toMatch(/getCohortLookupHook|__pi_cohort_lookup__/);
  });
});

// ── Dynamic-worker admission predicate (Slice 6) ─────────────────────────────

describe("peer-bus.ts — dynamic-worker admission via __pi_mesh_spawn_is_my_worker__", () => {
  it("reads __pi_mesh_spawn_is_my_worker__ predicate from globalThis", () => {
    expect(SRC).toMatch(/__pi_mesh_spawn_is_my_worker__/);
  });

  it("uses predicate alongside acceptsWorkFrom in the admission check", () => {
    // The predicate result (isMyWorker) must be used in combination with acceptsWorkFrom.includes.
    // Admission logic: admit if acceptsWorkFrom.includes(from) || isMyWorker (positive form), OR
    // equivalently deny if !acceptsWorkFrom.includes(from) && !isMyWorker (De Morgan form).
    expect(SRC).toMatch(/isMyWorker/);
    // Accept either the positive-OR or negative-AND (De Morgan equivalent) form.
    expect(SRC).toMatch(
      /acceptsWorkFrom\.includes.*\|\|.*isMyWorker|isMyWorker.*\|\|.*acceptsWorkFrom\.includes|!acceptsWorkFrom\.includes.*&&.*!isMyWorker|!isMyWorker.*&&.*!acceptsWorkFrom\.includes/s
    );
  });

  it("does NOT reference __pi_atomic_delegate_dispatch__ (deleted in Slice 6)", () => {
    expect(SRC).not.toMatch(/__pi_atomic_delegate_dispatch__/);
  });
});
