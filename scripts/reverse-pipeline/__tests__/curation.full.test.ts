// curation.full.test.ts — superset of the existing curation.test.ts.
// Covers every assertion the older file makes plus the gaps surfaced
// during the agent-composer test pass: isPatternOrGap, slugify edge
// cases, enumerateCurations error path on unknown patterns. Once this
// file lands, scripts/reverse-pipeline/__tests__/curation.test.ts is
// redundant and can be deleted.

import { strict as assert } from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  enumerateCurations,
  isPatternOrGap,
  slugify,
  type Curation,
} from "../curation.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const KNOWN_PATTERNS = [
  "recon",
  "drafter-with-approval",
  "confined-drafter",
  "scout-then-draft",
  "orchestrator",
] as const;

/* ---------- enumerateCurations --------------------------------------- */

describe("enumerateCurations", () => {
  it("produces at least one curation per known pattern + gap", () => {
    const all = enumerateCurations(REPO_ROOT);
    const patterns = new Set(all.map((c) => c.pattern));
    for (const p of KNOWN_PATTERNS) {
      assert.ok(patterns.has(p), `expected pattern ${p}`);
    }
    assert.ok(patterns.has("gap"));
  });

  it("tags are unique", () => {
    const all = enumerateCurations(REPO_ROOT);
    const tags = all.map((c) => c.tag);
    const dupes = tags.filter((t, i) => tags.indexOf(t) !== i);
    assert.equal(dupes.length, 0, `Duplicate tags: ${dupes.join(", ")}`);
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

  it("recon curations include the SKILL.md evidence anchor", () => {
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

  it("maxSeedsPerPattern of 0 yields no curations for that pattern", () => {
    const all = enumerateCurations(REPO_ROOT, {
      pattern: "recon",
      maxSeedsPerPattern: 0,
    });
    assert.equal(all.length, 0);
  });

  it("propagates an error when given an unknown pattern (via loadPatternSpec)", () => {
    assert.throws(
      () =>
        enumerateCurations(REPO_ROOT, {
          pattern: "made-up-pattern" as unknown as Curation["pattern"],
        }),
      /unknown pattern|ENOENT|not found|made-up-pattern/i,
    );
  });

  it("each assembly curation has a tag prefixed with its pattern name", () => {
    const all = enumerateCurations(REPO_ROOT);
    for (const c of all) {
      assert.ok(
        c.tag.startsWith(`${c.pattern}-`),
        `tag ${c.tag} should start with ${c.pattern}-`,
      );
    }
  });
});

/* ---------- slugify --------------------------------------------------- */

describe("slugify", () => {
  it("lowercases, strips non-alphanumerics, trims", () => {
    assert.equal(slugify("Write X — show me first"), "write-x-show-me-first");
    assert.equal(slugify(`"stage and preview"`), "stage-and-preview");
  });

  it("caps length at 40 characters", () => {
    const long = "a".repeat(100);
    assert.ok(slugify(long).length <= 40);
    assert.equal(slugify(long).length, 40);
  });

  it("returns empty string for empty input", () => {
    assert.equal(slugify(""), "");
  });

  it("returns empty string when all characters are non-alphanumeric", () => {
    assert.equal(slugify("!@#$%^&*()"), "");
    assert.equal(slugify("   "), "");
    assert.equal(slugify("---"), "");
  });

  it("strips leading and trailing dashes", () => {
    assert.equal(slugify("-hello world-"), "hello-world");
    assert.equal(slugify("...foo..."), "foo");
  });

  it("collapses consecutive non-alphanumerics into a single dash", () => {
    assert.equal(slugify("hello   world"), "hello-world");
    assert.equal(slugify("foo!!!bar???baz"), "foo-bar-baz");
  });

  it("drops unicode letters that are not in [a-z0-9]", () => {
    // The implementation only preserves a-z0-9; everything else becomes
    // a separator. This locks in the current behavior so accidental
    // regex changes get caught.
    assert.equal(slugify("café"), "caf");
    assert.equal(slugify("naïve"), "na-ve");
  });
});

/* ---------- isPatternOrGap ------------------------------------------- */

describe("isPatternOrGap", () => {
  it("returns true for every known pattern", () => {
    for (const p of KNOWN_PATTERNS) {
      assert.equal(isPatternOrGap(p), true, `expected ${p} → true`);
    }
  });

  it('returns true for the literal "gap"', () => {
    assert.equal(isPatternOrGap("gap"), true);
  });

  it("returns false for unknown strings", () => {
    assert.equal(isPatternOrGap("unknown"), false);
    assert.equal(isPatternOrGap(""), false);
    assert.equal(isPatternOrGap("RECON"), false); // case-sensitive
    assert.equal(isPatternOrGap("recon "), false); // no trim
    assert.equal(isPatternOrGap("gaps"), false);
  });
});
