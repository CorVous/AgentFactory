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

describe("extensions → scripts/_lib path resolution", () => {
  // Regression for the silent-no-op bug: extensions live at
  // pi-sandbox/.pi/extensions/<name>.ts, three levels below the repo root.
  // path.resolve(__dirname, "../../../scripts/_lib/<file>") lands on the
  // shared module; "../../../../…" went one level too far up to /home/user
  // and made createRequire fail with "Cannot find module …", which the
  // surrounding try/catch swallowed. Net effect: launcher-bridge / slash
  // commands / supervisor / bus-tail-emitter all silently degraded to
  // standalone mode, which is exactly the failure mode the user reported.
  const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));

  it("resolves scripts/_lib/launcher-socket.mjs from launcher-bridge.ts", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const src = fs.readFileSync(path.join(EXT_DIR, "launcher-bridge.ts"), "utf8");
    const match = src.match(/path\.resolve\(__dirname,\s*['"]([^'"]+launcher-socket\.mjs)['"]\)/);
    expect(match, "expected one path.resolve(__dirname, '…/launcher-socket.mjs') call").not.toBeNull();
    const resolved = path.resolve(EXT_DIR, match![1]);
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it.each([
    "slash-commands.ts",
    "bus-tail-emitter.ts",
    "supervisor.ts",
  ])("resolves scripts/_lib/launcher-envelope.mjs from %s", (file) => {
    const fs = require("node:fs") as typeof import("node:fs");
    const src = fs.readFileSync(path.join(EXT_DIR, file), "utf8");
    const matches = [...src.matchAll(/path\.resolve\(__dirname,\s*['"]([^'"]+launcher-envelope\.mjs)['"]\)/g)];
    expect(matches.length, `${file} should reference launcher-envelope.mjs at least once`).toBeGreaterThan(0);
    for (const match of matches) {
      const resolved = path.resolve(EXT_DIR, match[1]);
      expect(fs.existsSync(resolved), `${file}: ${match[1]} → ${resolved} must exist`).toBe(true);
    }
  });
});
