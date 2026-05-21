/**
 * slash-commands.test.ts — source-level assertions for the engine's
 * slash-commands extension (packages/engine/agent/extensions/slash-commands.ts).
 *
 * Verifies:
 *   1. Static import of sendControl from ./launcher-bridge.js (not createRequire).
 *   2. No _require("./launcher-bridge") usage.
 *   3. launcher-envelope.mjs resolves from ../lib/ (not ../../../scripts/_lib/).
 *
 * Contract: pure file-content assertions; no jiti, no pi runtime, no I/O
 * beyond reading the sibling source file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "slash-commands.ts"), "utf8");

describe("slash-commands — launcher-bridge wiring", () => {
  it("statically imports sendControl from ./launcher-bridge.js", () => {
    // jiti resolves .ts statically; createRequire cannot load .ts files.
    expect(SRC).toMatch(/import\s*\{[^}]*\bsendControl\b[^}]*\}\s*from\s*['"]\.\/launcher-bridge/);
  });

  it("does not _require('./launcher-bridge') (broken: createRequire cannot load .ts)", () => {
    expect(SRC).not.toMatch(/_require\([^)]*['"]launcher-bridge['"][^)]*\)/);
  });
});

describe("slash-commands — launcher-envelope path resolution", () => {
  it("resolves launcher-envelope.mjs from ../lib/ (engine-local copy)", () => {
    expect(SRC).toMatch(/\.\.\/lib\/launcher-envelope\.mjs/);
    // Must NOT point to scripts/_lib (that's the original location)
    expect(SRC).not.toMatch(/scripts\/_lib\/launcher-envelope\.mjs/);
  });

  it("engine-local launcher-envelope.mjs exists on disk", () => {
    const resolved = path.resolve(__dirname, "../lib/launcher-envelope.mjs");
    expect(existsSync(resolved)).toBe(true);
  });
});
