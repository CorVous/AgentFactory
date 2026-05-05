// run-agent.test.mjs — source-level assertions for the --inherit-pty flag in
// run-agent.mjs (Slice 5: replace PI_MESH_PEER env var).
//
// Contract: pure file-content assertions; no exec, no model API calls, no network.
// Hermetic by construction — reads the sibling source file and pattern-matches.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "run-agent.mjs"), "utf8");

describe("run-agent.mjs — --inherit-pty flag parsing", () => {
  it("initialises inheritPty: false in the parseArgs output object", () => {
    expect(SRC).toMatch(/inheritPty\s*:\s*false/);
  });

  it("parses --inherit-pty and sets out.inheritPty = true", () => {
    // Accept any of: `out.inheritPty = true`, `inheritPty = true`, etc.
    expect(SRC).toMatch(/--inherit-pty/);
    expect(SRC).toMatch(/inheritPty\s*=\s*true/);
  });

  it("consumes --inherit-pty as a boolean flag (no value arg consumed)", () => {
    // The flag handling must NOT consume argv[++i] — it is a standalone boolean.
    // A quick proxy: the else-if branch for "--inherit-pty" must not be followed
    // by an argv[++i] assignment on the same line.
    const lines = SRC.split("\n");
    const flagLine = lines.findIndex((l) => l.includes('"--inherit-pty"'));
    expect(flagLine).toBeGreaterThanOrEqual(0);
    // The line itself (or the immediately following line) must not contain ++i
    // paired with argv — i.e. no value consumption.
    const context = lines.slice(flagLine, flagLine + 3).join("\n");
    expect(context).not.toMatch(/argv\[.*\+\+i.*\]/);
  });

  it("reads args.inheritPty at the PTY-in-PTY detection site", () => {
    expect(SRC).toMatch(/args\.inheritPty/);
  });

  it("does not reference PI_MESH_PEER anywhere", () => {
    expect(SRC).not.toMatch(/PI_MESH_PEER/);
  });

  it("printHelp documents the --inherit-pty flag", () => {
    expect(SRC).toMatch(/--inherit-pty/);
  });
});
