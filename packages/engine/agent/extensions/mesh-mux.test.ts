/**
 * mesh-mux.test.ts — source-level assertions for the mesh-mux extension.
 *
 * Tests verify that the host cwd is captured at session_start and threaded
 * through MeshMuxState so spawned workers inherit the caller's working
 * directory instead of the hard-coded REPO_ROOT (issue #172).
 *
 * Contract: pure file-content assertions; no jiti, no pi runtime, no live
 * child processes. Hermetic by construction.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "mesh-mux.ts"), "utf8");

// ── Source-level assertions — cwd inheritance (issue #172) ──────────────────

describe("mesh-mux.ts — cwd inheritance (issue #172)", () => {
  it("does NOT pass cwd: REPO_ROOT to pool.spawn", () => {
    expect(SRC).not.toMatch(/cwd:\s*REPO_ROOT/);
  });

  it("passes the captured host cwd to pool.spawn", () => {
    expect(SRC).toMatch(/cwd:\s*state\.hostCwd/);
  });

  it("captures ctx.cwd at session_start and stores it on state", () => {
    // ctx.cwd must appear in the source (it's captured in the session_start handler)
    expect(SRC).toMatch(/ctx\.cwd/);
    // and must be assigned to hostCwd on the state object
    expect(SRC).toMatch(/hostCwd:\s*ctx\.cwd/);
  });

  it("threads hostCwd through MeshMuxState interface", () => {
    // The MeshMuxState interface must declare hostCwd: string
    expect(SRC).toMatch(/hostCwd:\s*string/);
  });

  it("REPO_ROOT is still present (used by AGENTS_DIR and PI_BIN)", () => {
    // REPO_ROOT must still exist — used for AGENTS_DIR path
    expect(SRC).toMatch(/REPO_ROOT/);
    expect(SRC).toMatch(/AGENTS_DIR/);
    expect(SRC).toMatch(/PI_BIN/);
  });
});
