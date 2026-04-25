import { strict as assert } from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { loadPatternSpec } from "../lib/pattern-spec.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("pattern-spec", () => {
  it("parses drafter-with-approval", () => {
    const p = loadPatternSpec(REPO_ROOT, "drafter-with-approval");
    assert.deepEqual(p.components, [
      "cwd-guard.ts",
      "sandbox-fs.ts",
      "stage-write.ts",
    ]);
    assert.ok(p.tools.includes("stage_write"));
    assert.ok(p.tools.includes("sandbox_ls"));
    assert.ok(!p.tools.includes("write"));
    assert.ok(!p.tools.includes("ls"));
    assert.equal(p.mode, "json");
    assert.equal(p.tier, "TASK_MODEL");
  });

  it("parses recon (now requires cwd-guard for sandbox read verbs)", () => {
    const p = loadPatternSpec(REPO_ROOT, "recon");
    assert.ok(p.components.includes("cwd-guard.ts"));
    assert.ok(p.components.includes("emit-summary.ts"));
    assert.ok(p.tools.includes("emit_summary"));
    assert.ok(p.tools.includes("sandbox_ls"));
    assert.ok(!p.tools.includes("ls"));
    assert.ok(!p.tools.includes("stage_write"));
    assert.ok(!p.tools.includes("write"));
  });

  it("parses confined-drafter", () => {
    const p = loadPatternSpec(REPO_ROOT, "confined-drafter");
    assert.deepEqual(p.components, ["cwd-guard.ts", "sandbox-fs.ts"]);
    assert.ok(p.tools.includes("sandbox_write"));
    assert.ok(p.tools.includes("sandbox_edit"));
    assert.ok(p.tools.includes("sandbox_read"));
    assert.ok(!p.tools.includes("read"));
    assert.ok(!p.tools.includes("stage_write"));
  });

  it("parses scout-then-draft (union of both phases)", () => {
    const p = loadPatternSpec(REPO_ROOT, "scout-then-draft");
    // Flatten the two phases' component lists.
    assert.ok(p.components.includes("emit-summary.ts"));
    assert.ok(p.components.includes("cwd-guard.ts"));
    assert.ok(p.components.includes("sandbox-fs.ts"));
    assert.ok(p.components.includes("stage-write.ts"));
    assert.ok(p.tools.includes("stage_write"));
    assert.ok(p.tools.includes("emit_summary"));
    assert.ok(p.tools.includes("sandbox_ls"));
    assert.ok(p.tools.includes("sandbox_read"));
  });
});
