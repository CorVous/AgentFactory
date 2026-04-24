import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { seedReconFixture } from "../lib/probes.ts";
import type { ProbeContext } from "../lib/probes.ts";

function mkCtx(
  overrides: Partial<ProbeContext> & { logDir: string },
): ProbeContext {
  return {
    repoRoot: overrides.repoRoot ?? "/unused",
    logDir: overrides.logDir,
    cmdName: overrides.cmdName ?? "recon",
    taskModel: overrides.taskModel ?? "unused-model",
    probeArgs: overrides.probeArgs ?? " skills/pi-agent-builder",
    evidenceAnchor: overrides.evidenceAnchor,
  };
}

describe("seedReconFixture", () => {
  it("writes the evidence anchor file under the run dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probes-test-"));
    try {
      const ctx = mkCtx({ logDir: tmp, evidenceAnchor: "SKILL.md" });
      seedReconFixture(ctx);
      const expected = path.join(tmp, "skills", "pi-agent-builder", "SKILL.md");
      assert.ok(fs.existsSync(expected), "expected seed file missing");
      const body = fs.readFileSync(expected, "utf8");
      assert.ok(body.includes("SKILL.md"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("defaults the anchor filename to SKILL.md", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probes-test-"));
    try {
      const ctx = mkCtx({ logDir: tmp });
      seedReconFixture(ctx);
      assert.ok(fs.existsSync(path.join(tmp, "skills", "pi-agent-builder", "SKILL.md")));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips absolute probeArgs (never writes outside the run dir)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probes-test-"));
    try {
      const ctx = mkCtx({ logDir: tmp, probeArgs: " /etc/passwd" });
      seedReconFixture(ctx);
      assert.equal(fs.readdirSync(tmp).length, 0, "run dir should be untouched");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips probeArgs containing '..'", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probes-test-"));
    try {
      const ctx = mkCtx({ logDir: tmp, probeArgs: " ../evil" });
      seedReconFixture(ctx);
      assert.equal(fs.readdirSync(tmp).length, 0, "run dir should be untouched");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent — does not overwrite an existing anchor file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probes-test-"));
    try {
      const ctx = mkCtx({ logDir: tmp });
      const target = path.join(tmp, "skills", "pi-agent-builder", "SKILL.md");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "pre-existing content");
      seedReconFixture(ctx);
      assert.equal(fs.readFileSync(target, "utf8"), "pre-existing content");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
