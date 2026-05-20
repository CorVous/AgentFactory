// no-env-fallbacks.test.mjs — repo-wide guard that asserts PI_AGENT_BUS_ROOT,
// PI_AGENT_NAME, and AGENT_DEBUG do not appear in non-test source files in
// scripts/ or pi-sandbox/ (Slice 6: --debug flag + drop env-var fallbacks).
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

describe("env-var fallback zero-hit guard (Slice 6)", () => {
  it("grep finds no PI_AGENT_BUS_ROOT, PI_AGENT_NAME, or AGENT_DEBUG in scripts/ (excluding test files)", () => {
    let output = "";
    let exitCode = 0;
    try {
      output = execSync(
        `grep -rn --include="*.mjs" --include="*.ts" --include="*.js" ` +
          `--exclude="*.test.*" --exclude="*.spec.*" ` +
          `-E "process\\.env\\.(PI_AGENT_BUS_ROOT|PI_AGENT_NAME|AGENT_DEBUG)" ` +
          `"${REPO_ROOT}/scripts"`,
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

  it("grep finds no PI_AGENT_BUS_ROOT, PI_AGENT_NAME, or AGENT_DEBUG in pi-sandbox/ (excluding test files)", () => {
    let output = "";
    let exitCode = 0;
    try {
      output = execSync(
        `grep -rn --include="*.mjs" --include="*.ts" --include="*.js" ` +
          `--exclude="*.test.*" --exclude="*.spec.*" ` +
          `-E "process\\.env\\.(PI_AGENT_BUS_ROOT|PI_AGENT_NAME|AGENT_DEBUG)" ` +
          `"${REPO_ROOT}/pi-sandbox"`,
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
