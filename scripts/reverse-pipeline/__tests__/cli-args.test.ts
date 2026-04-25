// cli-args.test.ts — covers parseArgs in scripts/reverse-pipeline/index.ts.
// Importing index.ts directly is safe because main() is gated behind an
// "invoked directly" check, so module load no longer auto-runs the CLI.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseArgs } from "../index.ts";

describe("parseArgs", () => {
  it("returns documented defaults for an empty argv", () => {
    const a = parseArgs([]);
    assert.equal(a.dryRun, false);
    assert.equal(a.help, false);
    assert.equal(a.nVariants, 3);
    assert.equal(a.pattern, undefined);
    assert.equal(a.only, undefined);
    assert.equal(a.maxSeedsPerPattern, undefined);
  });

  it("parses --pattern and --only", () => {
    const a = parseArgs(["--pattern", "recon", "--only", "gap-foo-01"]);
    assert.equal(a.pattern, "recon");
    assert.equal(a.only, "gap-foo-01");
  });

  it("parses --dry-run as a boolean", () => {
    const a = parseArgs(["--dry-run"]);
    assert.equal(a.dryRun, true);
  });

  it("rejects --run (removed flag) as an unknown argument", () => {
    assert.throws(() => parseArgs(["--run"]), /Unknown argument: --run/);
  });

  it("parses --n-variants and --max-seeds with numeric values", () => {
    const a = parseArgs(["--n-variants", "5", "--max-seeds", "2"]);
    assert.equal(a.nVariants, 5);
    assert.equal(a.maxSeedsPerPattern, 2);
  });

  it("recognizes -h and --help", () => {
    assert.equal(parseArgs(["-h"]).help, true);
    assert.equal(parseArgs(["--help"]).help, true);
  });

  it("rejects --n-variants with a non-numeric value", () => {
    assert.throws(
      () => parseArgs(["--n-variants", "foo"]),
      /--n-variants expects a positive integer/,
    );
  });

  it("rejects --n-variants of 0", () => {
    assert.throws(
      () => parseArgs(["--n-variants", "0"]),
      /--n-variants expects a positive integer/,
    );
  });

  it("rejects --n-variants of a negative integer", () => {
    assert.throws(
      () => parseArgs(["--n-variants", "-3"]),
      /--n-variants expects a positive integer/,
    );
  });

  it("throws on an unknown flag, naming the offending arg", () => {
    assert.throws(
      () => parseArgs(["--bogus-flag"]),
      /Unknown argument: --bogus-flag/,
    );
  });

  it("preserves later occurrences of the same flag (last wins)", () => {
    const a = parseArgs(["--pattern", "recon", "--pattern", "gap"]);
    assert.equal(a.pattern, "gap");
  });

  it("does NOT validate pattern names — that's main()'s job", () => {
    // parseArgs just gathers strings; main() runs isPatternOrGap() to
    // bounce invalid values. Pin the split of responsibilities so a
    // future refactor that pushes validation into parseArgs is
    // intentional.
    const a = parseArgs(["--pattern", "totally-fake"]);
    assert.equal(a.pattern, "totally-fake");
  });
});
