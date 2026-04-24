import { strict as assert } from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { enumerateCurations, slugify } from "../curation.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

describe("enumerateCurations", () => {
  it("produces at least one curation per known pattern + gap", () => {
    const all = enumerateCurations(REPO_ROOT);
    const patterns = new Set(all.map((c) => c.pattern));
    assert.ok(patterns.has("recon"));
    assert.ok(patterns.has("drafter-with-approval"));
    assert.ok(patterns.has("confined-drafter"));
    assert.ok(patterns.has("scout-then-draft"));
    assert.ok(patterns.has("orchestrator"));
    assert.ok(patterns.has("gap"));
  });

  it("tags are unique", () => {
    const all = enumerateCurations(REPO_ROOT);
    const tags = all.map((c) => c.tag);
    const set = new Set(tags);
    assert.equal(
      tags.length,
      set.size,
      `Duplicate tags: ${tags.filter((t, i) => tags.indexOf(t) !== i).join(", ")}`,
    );
  });

  it("assembly curations carry the pattern's parts list", () => {
    const all = enumerateCurations(REPO_ROOT, { pattern: "drafter-with-approval" });
    assert.ok(all.length > 0);
    for (const c of all) {
      assert.equal(c.kind, "assembly");
      assert.deepEqual(c.components, ["cwd-guard.ts", "stage-write.ts"]);
      assert.ok(c.probe, "expected a probe");
    }
  });

  it("recon curations include evidence anchor", () => {
    const all = enumerateCurations(REPO_ROOT, { pattern: "recon" });
    assert.ok(all.length > 0);
    for (const c of all) {
      assert.equal(c.probe?.evidence_anchor, "SKILL.md");
    }
  });

  it("gap curations have no components and no probe", () => {
    const all = enumerateCurations(REPO_ROOT, { pattern: "gap" });
    assert.ok(all.length >= 3, "expected several gap seeds");
    for (const c of all) {
      assert.equal(c.kind, "gap");
      assert.equal(c.pattern, "gap");
      assert.deepEqual(c.components, []);
      assert.equal(c.probe, undefined);
      assert.ok(c.closestMatch, "gap curation should carry a closestMatch");
    }
  });

  it("respects maxSeedsPerPattern", () => {
    const all = enumerateCurations(REPO_ROOT, {
      pattern: "recon",
      maxSeedsPerPattern: 2,
    });
    assert.equal(all.length, 2);
  });
});

describe("slugify", () => {
  it("lowercases, strips non-alphanumerics, trims", () => {
    assert.equal(slugify("Write X — show me first"), "write-x-show-me-first");
    assert.equal(slugify(`"stage and preview"`), "stage-and-preview");
  });

  it("caps length", () => {
    const long = "a".repeat(100);
    assert.ok(slugify(long).length <= 40);
  });
});
