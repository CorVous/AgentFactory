import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { findSpawnInvocations } from "../lib/artifact.ts";

const DRAFTER_SRC = `
import path from "node:path";
const CWD_GUARD = path.resolve(".", "components", "cwd-guard.ts");
const STAGE_WRITE = path.resolve(".", "components", "stage-write.ts");
const child = spawn(
  "pi",
  [
    "-e", CWD_GUARD,
    "-e", STAGE_WRITE,
    "--mode", "json",
    "--tools", "stage_write,ls",
    "--no-extensions",
    "--no-session",
    "--thinking", "off",
    "--provider", "openrouter",
    "--model", MODEL,
    "-p", prompt,
  ],
  { stdio: ["ignore", "pipe", "pipe"], cwd: sandboxRoot, env: { ...process.env, PI_SANDBOX_ROOT: sandboxRoot } },
);
`;

const TWO_SPAWNS_SRC = `
const EMIT = path.resolve(".", "components", "emit-summary.ts");
const CWD_GUARD = path.resolve(".", "components", "cwd-guard.ts");
const STAGE = path.resolve(".", "components", "stage-write.ts");
const a = spawn("pi", ["-e", EMIT, "--mode", "json", "--tools", "ls,read,grep,glob,emit_summary", "--no-extensions", "-p", "x"]);
const b = spawn("pi", ["-e", CWD_GUARD, "-e", STAGE, "--mode", "json", "--tools", "stage_write,ls", "--no-extensions", "-p", "y"]);
`;

describe("findSpawnInvocations", () => {
  it("parses a single drafter-with-approval spawn", () => {
    const spawns = findSpawnInvocations(DRAFTER_SRC);
    assert.equal(spawns.length, 1);
    const s = spawns[0];
    assert.deepEqual(s.eFlagComponents, ["cwd-guard.ts", "stage-write.ts"]);
    assert.equal(s.mode, "json");
    assert.equal(s.toolsCsv, "stage_write,ls");
    assert.deepEqual(s.tools, ["stage_write", "ls"]);
    assert.equal(s.noExtensions, true);
    assert.equal(s.noSession, true);
    assert.equal(s.thinkingOff, true);
  });

  it("parses two spawns (scout-then-draft)", () => {
    const spawns = findSpawnInvocations(TWO_SPAWNS_SRC);
    assert.equal(spawns.length, 2);
    assert.deepEqual(spawns[0].eFlagComponents, ["emit-summary.ts"]);
    assert.deepEqual(spawns[1].eFlagComponents, ["cwd-guard.ts", "stage-write.ts"]);
  });
});
