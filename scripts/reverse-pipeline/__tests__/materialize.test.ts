import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, it } from "node:test";
import { loadTestSpec } from "../../grader/lib/test-spec.ts";
import type { Curation } from "../curation.ts";
import { buildTestSpec, materialize, serializeTestSpec } from "../materialize.ts";
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

describe("buildTestSpec", () => {
  it("round-trips assembly through the Zod schema", () => {
    const spec = buildTestSpec(ASSEMBLY_CURATION, "Do X — show me before it saves. Keep it simple.");
    assert.equal(spec.skill, "pi-agent-assembler");
    if (spec.expectation.kind !== "assembly") {
      assert.fail("expected assembly expectation");
    }
    assert.equal(spec.expectation.pattern, "drafter-with-approval");
    assert.equal(spec.probe?.args, " create a file hello-probe.md with the text hi");
  });

  it("round-trips gap with closest_match", () => {
    const spec = buildTestSpec(GAP_CURATION, "I want an agent that tails logs on a schedule.");
    if (spec.expectation.kind !== "gap") {
      assert.fail("expected gap expectation");
    }
    assert.equal(spec.expectation.closest_match, "none");
    assert.equal(spec.probe, undefined);
  });

  it("rejects empty prompts", () => {
    assert.throws(() => buildTestSpec(ASSEMBLY_CURATION, ""));
  });
});

describe("serializeTestSpec", () => {
  it("produces YAML that loadTestSpec accepts", () => {
    const spec = buildTestSpec(ASSEMBLY_CURATION, "Draft something, show me first.");
    const yaml = serializeTestSpec(ASSEMBLY_CURATION, spec, {
      generatorModel: "test-model",
      temperature: 0.5,
      variantIndex: 2,
      variantCount: 3,
    });
    // Header is a comment block; YAML body should parse.
    const parsed = YAML.parse(yaml);
    assert.equal(parsed.skill, "pi-agent-assembler");
    assert.equal(parsed.expectation.kind, "assembly");
    // Write + reload through loadTestSpec to exercise the real validator.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reverse-pipeline-test-"));
    try {
      fs.writeFileSync(path.join(tmp, "test.yaml"), yaml);
      const reloaded = loadTestSpec(tmp);
      assert.equal(reloaded.skill, "pi-agent-assembler");
      if (reloaded.expectation.kind !== "assembly") assert.fail("wrong kind after reload");
      assert.equal(reloaded.expectation.pattern, "drafter-with-approval");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("header carries regeneration hint with the tag", () => {
    const spec = buildTestSpec(ASSEMBLY_CURATION, "x");
    const yaml = serializeTestSpec(ASSEMBLY_CURATION, spec, {
      generatorModel: "m",
      temperature: 0,
      variantIndex: 1,
      variantCount: 1,
    });
    assert.ok(yaml.startsWith("# Auto-generated"));
    assert.ok(yaml.includes(`--only ${ASSEMBLY_CURATION.tag}`));
  });
});

describe("materialize", () => {
  it("writes under tasks/generated/<tag>/test.yaml", () => {
    const tag = "__unit-test-materialize-01";
    const curation: Curation = { ...ASSEMBLY_CURATION, tag };
    const out = materialize(REPO_ROOT, curation, "Draft something, show me before saving.", {
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
    } finally {
      // Clean up the generated dir so tasks/generated stays ignored.
      fs.rmSync(
        path.join(REPO_ROOT, "scripts", "task-runner", "tasks", "generated", tag),
        { recursive: true, force: true },
      );
    }
  });
});

describe("pickLeastLeakyVariant", () => {
  it("prefers a variant without the pattern name", () => {
    const curation: Curation = ASSEMBLY_CURATION;
    const variants = [
      "I want a drafter that stages writes before disk.", // leaks 'drafter', 'stage'
      "I'd like an agent that drafts a file and lets me approve before saving to disk.", // leaks 'draft'
      "I need a tool that writes a new file but checks with me first.", // cleanest
    ];
    const idx = pickLeastLeakyVariant(variants, curation);
    assert.equal(idx, 2);
  });

  it("ties broken by shorter variant", () => {
    const curation: Curation = ASSEMBLY_CURATION;
    const variants = [
      "Write a file but let me confirm before it lands on disk, please and thank you.",
      "Write a file but let me confirm before it lands on disk.",
    ];
    const idx = pickLeastLeakyVariant(variants, curation);
    assert.equal(idx, 1);
  });
});
