/**
 * slash-commands.test.ts — regression test for the slash-commands extension's
 * launcher-bridge wiring.
 *
 * The bug being guarded: an earlier revision used
 *   const _require = createRequire(import.meta.url);
 *   _require(path.resolve(__dirname, "launcher-bridge"));
 * to look up sendControl at handler-call time. createRequire is plain Node
 * CommonJS resolution — it cannot load a `.ts` file. The require always threw
 * `Cannot find module …/launcher-bridge`, the try/catch swallowed it, and
 * `/focus`, `/tail`, `/pin`, and the `/decisions` non-UI fallback all reported
 *   "launcher-bridge not active (standalone mode)".
 *
 * The fix is to use a static `import { sendControl } from "./launcher-bridge"`,
 * which jiti rewrites during transformation. This test reads the extension
 * source and asserts that the static import is present and the broken
 * dynamic-require pattern is absent.
 *
 * Contract: pure file-content assertions; no jiti, no pi runtime, no I/O
 * beyond reading the sibling source file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "slash-commands.ts"), "utf8");

describe("slash-commands — launcher-bridge wiring", () => {
  it("statically imports sendControl from ./launcher-bridge", () => {
    // The transformation jiti applies to .ts handles `./launcher-bridge`
    // resolution; createRequire cannot. Tolerant regex so renaming the local
    // alias (e.g. `bridgeSendControl`) doesn't accidentally fail this guard.
    expect(SRC).toMatch(/import\s*\{[^}]*\bsendControl\b[^}]*\}\s*from\s*['"]\.\/launcher-bridge['"]/);
  });

  it("does not _require('./launcher-bridge') (broken: createRequire cannot load .ts)", () => {
    // Match any createRequire-style call that resolves to launcher-bridge —
    // both `_require("launcher-bridge")` and `_require(path.resolve(__dirname, "launcher-bridge"))`.
    expect(SRC).not.toMatch(/_require\([^)]*['"]launcher-bridge['"][^)]*\)/);
  });
});
