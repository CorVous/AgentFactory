// materialize.full.test.ts — superset of the existing materialize.test.ts.
// Re-covers the round-trip + tag-derived path assertions and adds
// edge-case coverage for buildTestSpec validation, header content,
// idempotent materialization, and pickLeastLeakyVariant boundary
// conditions. Once this file lands, materialize.test.ts is redundant.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import YAML from "yaml";

import { loadTestSpec } from "../../grader/lib/test-spec.ts";
import type { Curation } from "../curation.ts";
import {
  buildTestSpec,
  materialize,
  serializeTestSpec,
} from "../materialize.ts";
import { pickLeastLeakyVariant } from "../curate-to-prompt.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const ASSEMBLY_CURATION: Curation = {
  kind: "assembly",
  pattern: "drafter-with-approval",
  phrasingSeed: "stage and preview",
  components: ["cwd-guard.ts", "stage-write.ts"],
  probe: { args: " create a file hello-probe.md with the text hi" },
  tag: "drafter-with-approval-stage-and-preview-01",
};

const GAP_CURATION: Curation = {
  kind: "gap",
  pattern: "gap",
  phrasingSeed: "agent that tails a log file on a cron schedule",
  components: [],
  tag: "gap-cron-tail-01",
  closestMatch: "none",
};

/* ---------- buildTestSpec -------------------------------------------- */

describe("buildTestSpec", () => {
  it("round-trips assembly through the Zod schema", () => {
    const spec = buildTestSpec(ASSEMBLY_CURATION, "Do X — show me before it saves.");
    assert.equal(spec.skill, "pi-agent-assembler");
    if (spec.expectation.kind !== "assembly") assert.fail("expected assembly");
    assert.equal(spec.expectation.pattern, "drafter-with-approval");
    assert.equal(spec.probe?.args, " create a file hello-probe.md with the text hi");
  });

  it("round-trips gap with closest_match", () => {
    const spec = buildTestSpec(GAP_CURATION, "I want an agent that tails logs.");
    if (spec.expectation.kind !== "gap") assert.fail("expected gap");
    assert.equal(spec.expectation.closest_match, "none");
    assert.equal(spec.probe, undefined);
  });

  it("rejects empty prompts", () => {
    assert.throws(() => buildTestSpec(ASSEMBLY_CURATION, ""));
  });

  it("accepts long prompts (no upper-bound enforced by the schema)", () => {
    const long = "x ".repeat(2000); // ~4 KB
    const spec = buildTestSpec(ASSEMBLY_CURATION, long);
    assert.equal(spec.prompt.length, long.length);
  });

  it("propagates extra_tools and extra_components onto the assembly expectation", () => {
    const c: Curation = {
      ...ASSEMBLY_CURATION,
      extraTools: ["read"],
      extraComponents: ["foo.ts"],
    };
    const spec = buildTestSpec(c, "p");
    if (spec.expectation.kind !== "assembly") assert.fail("expected assembly");
    assert.deepEqual(spec.expectation.extra_tools, ["read"]);
    assert.deepEqual(spec.expectation.extra_components, ["foo.ts"]);
  });

  it("omits closest_match when the gap curation has none", () => {
    const c: Curation = { ...GAP_CURATION, closestMatch: undefined };
    const spec = buildTestSpec(c, "p");
    if (spec.expectation.kind !== "gap") assert.fail("expected gap");
    assert.equal(spec.expectation.closest_match, undefined);
  });
});

/* ---------- serializeTestSpec ---------------------------------------- */

describe("serializeTestSpec", () => {
  it("produces YAML that loadTestSpec accepts", () => {
    const spec = buildTestSpec(ASSEMBLY_CURATION, "Draft something, show me first.");
    const yaml = serializeTestSpec(ASSEMBLY_CURATION, spec, {
      generatorModel: "test-model",
      temperature: 0.5,
      variantIndex: 2,
      variantCount: 3,
    });
    const parsed = YAML.parse(yaml);
    assert.equal(parsed.skill, "pi-agent-assembler");
    assert.equal(parsed.expectation.kind, "assembly");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reverse-pipeline-"));
    try {
      fs.writeFileSync(path.join(tmp, "test.yaml"), yaml);
      const reloaded = loadTestSpec(tmp);
      assert.equal(reloaded.skill, "pi-agent-assembler");
      if (reloaded.expectation.kind !== "assembly") assert.fail("wrong kind");
      assert.equal(reloaded.expectation.pattern, "drafter-with-approval");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("header captures provenance: model, temperature, variant index/count, regenerate hint, tag", () => {
    const spec = buildTestSpec(ASSEMBLY_CURATION, "x");
    const yaml = serializeTestSpec(ASSEMBLY_CURATION, spec, {
      generatorModel: "lead-model-test",
      temperature: 0.42,
      variantIndex: 2,
      variantCount: 5,
    });
    assert.ok(yaml.startsWith("# Auto-generated"));
    assert.match(yaml, /# Curation: kind=assembly pattern=drafter-with-approval tag=/);
    assert.match(yaml, /# Seed: stage and preview/);
    assert.match(yaml, /model=lead-model-test/);
    assert.match(yaml, /temperature=0\.42/);
    assert.match(yaml, /variant=2\/5/);
    assert.match(yaml, new RegExp(`--only ${ASSEMBLY_CURATION.tag}`));
  });

  it("collapses multi-line phrasing seeds into a single header line", () => {
    const c: Curation = { ...ASSEMBLY_CURATION, phrasingSeed: "line one\n  line two" };
    const spec = buildTestSpec(c, "x");
    const yaml = serializeTestSpec(c, spec, {
      generatorModel: "m",
      temperature: 0,
      variantIndex: 1,
      variantCount: 1,
    });
    assert.match(yaml, /# Seed: line one line two/);
    assert.equal(yaml.includes("# Seed: line one\n  line two"), false);
  });
});

/* ---------- materialize ---------------------------------------------- */

describe("materialize", () => {
  it("writes under tasks/generated/<tag>/test.yaml", () => {
    const tag = "__unit-test-materialize-full-01";
    const curation: Curation = { ...ASSEMBLY_CURATION, tag };
    const out = materialize(REPO_ROOT, curation, "Draft something, show me first.", {
      generatorModel: "m",
      temperature: 0,
      variantIndex: 1,
      variantCount: 1,
    });
    try {
      assert.ok(fs.existsSync(out.yamlPath));
      assert.equal(
        path.relative(REPO_ROOT, out.yamlPath),
        path.join("scripts", "task-runner", "tasks", "generated", tag, "test.yaml"),
      );
      assert.equal(out.relTaskName, path.join("generated", tag));
    } finally {
      fs.rmSync(
        path.join(REPO_ROOT, "scripts", "task-runner", "tasks", "generated", tag),
        { recursive: true, force: true },
      );
    }
  });

  it("a second materialize call with the same tag overwrites the YAML", () => {
    const tag = "__unit-test-materialize-full-overwrite-01";
    const curation: Curation = { ...ASSEMBLY_CURATION, tag };
    const dir = path.join(REPO_ROOT, "scripts", "task-runner", "tasks", "generated", tag);
    try {
      const out1 = materialize(REPO_ROOT, curation, "first", {
        generatorModel: "m",
        temperature: 0,
        variantIndex: 1,
        variantCount: 1,
      });
      const yaml1 = fs.readFileSync(out1.yamlPath, "utf8");
      const out2 = materialize(REPO_ROOT, curation, "second prompt body", {
        generatorModel: "m",
        temperature: 0,
        variantIndex: 1,
        variantCount: 1,
      });
      assert.equal(out1.yamlPath, out2.yamlPath);
      const yaml2 = fs.readFileSync(out2.yamlPath, "utf8");
      assert.notEqual(yaml1, yaml2);
      assert.match(yaml2, /second prompt body/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ---------- pickLeastLeakyVariant ----------------------------------- */

describe("pickLeastLeakyVariant", () => {
  it("prefers a variant without the pattern name", () => {
    const variants = [
      "I want a drafter that stages writes before disk.", // leaks 'drafter', 'stage'
      "I'd like an agent that drafts a file and lets me approve before saving.", // leaks 'draft'
      "I need a tool that writes a new file but checks with me first.", // cleanest
    ];
    assert.equal(pickLeastLeakyVariant(variants, ASSEMBLY_CURATION), 2);
  });

  it("ties broken by shorter variant", () => {
    const variants = [
      "Write a file but let me confirm before it lands on disk, please.",
      "Write a file but let me confirm before it lands on disk.",
    ];
    assert.equal(pickLeastLeakyVariant(variants, ASSEMBLY_CURATION), 1);
  });

  it("returns 0 for a single-variant list", () => {
    assert.equal(pickLeastLeakyVariant(["only one"], ASSEMBLY_CURATION), 0);
  });

  it("returns 0 for an empty list (default initialization)", () => {
    // The implementation initializes `best = 0` and never updates if the
    // forEach loop sees no variants; the caller should never pass [], but
    // we pin the current behavior so a future change is intentional.
    assert.equal(pickLeastLeakyVariant([], ASSEMBLY_CURATION), 0);
  });

  it("for a gap curation, picks the shortest variant when none leak", () => {
    // Gap forbiddenTokens still includes the always-on vocabulary
    // (stage, drafter, recon, …) but no pattern-name token, so a request
    // about "tailing a log on a schedule" should score 0 hits across
    // all three and the shortest wins.
    const variants = [
      "I want an agent that watches a log and pings me when something breaks, every five minutes.",
      "I want an agent that watches a log and pings me when something breaks.",
      "Build a tool that polls my log and alerts me on errors.",
    ];
    const idx = pickLeastLeakyVariant(variants, GAP_CURATION);
    // Shortest is index 2 (50 chars) given no leaks.
    assert.equal(idx, 2);
  });
});
