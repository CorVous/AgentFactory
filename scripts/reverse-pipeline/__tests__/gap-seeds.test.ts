// gap-seeds.test.ts — data-integrity checks for GAP_SEEDS. The reverse
// pipeline derives one curation per seed; a stray duplicate or empty
// field would silently produce duplicate tags or malformed prompts
// downstream. These checks run in milliseconds and catch copy/paste
// regressions before they ship.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { GAP_SEEDS } from "../gap-seeds.ts";

const KNOWN_PATTERNS_OR_NONE = new Set([
  "recon",
  "drafter-with-approval",
  "confined-drafter",
  "scout-then-draft",
  "orchestrator",
  "none",
]);

describe("GAP_SEEDS", () => {
  it("has at least three entries (otherwise the gap track is meaningless)", () => {
    assert.ok(GAP_SEEDS.length >= 3, `expected ≥3 seeds, got ${GAP_SEEDS.length}`);
  });

  it("every entry has a non-empty seed, closestMatch, and why", () => {
    for (const s of GAP_SEEDS) {
      assert.ok(typeof s.seed === "string" && s.seed.trim().length > 0, `seed empty: ${JSON.stringify(s)}`);
      assert.ok(
        typeof s.closestMatch === "string" && s.closestMatch.trim().length > 0,
        `closestMatch empty: ${JSON.stringify(s)}`,
      );
      assert.ok(typeof s.why === "string" && s.why.trim().length > 0, `why empty: ${JSON.stringify(s)}`);
    }
  });

  it('every closestMatch is a known pattern or the literal "none"', () => {
    for (const s of GAP_SEEDS) {
      assert.ok(
        KNOWN_PATTERNS_OR_NONE.has(s.closestMatch),
        `unexpected closestMatch="${s.closestMatch}" — expected one of ${[...KNOWN_PATTERNS_OR_NONE].join(", ")}`,
      );
    }
  });

  it("seed strings are unique", () => {
    const seeds = GAP_SEEDS.map((s) => s.seed);
    const set = new Set(seeds);
    assert.equal(seeds.length, set.size, "duplicate seed strings");
  });

  it("seeds are reasonably long English (≥ 30 chars) so the generator has signal", () => {
    for (const s of GAP_SEEDS) {
      assert.ok(s.seed.length >= 30, `seed too short to paraphrase: "${s.seed}"`);
    }
  });
});
