// no-pi-mesh-peer.test.mjs — repo-wide guard that asserts PI_MESH_PEER does not
// appear in scripts/ or pi-sandbox/ (Slice 5: --inherit-pty replaces env var).
//
// Uses child_process.execSync to grep the relevant directories. The grep command
// deliberately excludes test files themselves (*.test.*) to avoid self-referential
// false positives. The test fails if grep finds any hit or exits with an
// unexpected error (exit code 1 = hits found, any other code = tool failure).
//
// Contract: no model API calls, no network, no env from models.env.

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

describe("PI_MESH_PEER zero-hit guard", () => {
  it("grep finds no PI_MESH_PEER in scripts/ (excluding test files)", () => {
    let output = "";
    let exitCode = 0;
    try {
      output = execSync(
        `grep -rn --include="*.mjs" --include="*.ts" --include="*.js" ` +
          `--exclude="*.test.*" --exclude="*.spec.*" ` +
          `PI_MESH_PEER "${REPO_ROOT}/scripts"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = err.stdout ?? "";
    }
    // grep exit code 1 means "no matches" — that is the expected success case.
    // exit code 0 means matches were found — the test must fail.
    // Any other exit code indicates a tool error — let the error propagate.
    expect(exitCode).toBe(1);
    expect(output.trim()).toBe("");
  });

  it("grep finds no PI_MESH_PEER in pi-sandbox/ (excluding test files)", () => {
    let output = "";
    let exitCode = 0;
    try {
      output = execSync(
        `grep -rn --include="*.mjs" --include="*.ts" --include="*.js" ` +
          `--exclude="*.test.*" --exclude="*.spec.*" ` +
          `PI_MESH_PEER "${REPO_ROOT}/pi-sandbox"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = err.stdout ?? "";
    }
    expect(exitCode).toBe(1);
    expect(output.trim()).toBe("");
  });
});
