// curate-to-prompt.test.ts — covers the previously-internal helpers in
// curate-to-prompt.ts that the existing test suite did not exercise:
// forbiddenTokens, extractFinalMessage, flattenContent. These are the
// pieces that pickLeastLeakyVariant and runPi rely on, and a regression
// in any of them silently corrupts generated prompts. generatePrompt
// itself spawns a child pi and is intentionally out of scope for unit
// tests.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  extractFinalMessage,
  flattenContent,
  forbiddenTokens,
} from "../curate-to-prompt.ts";
import type { Curation } from "../curation.ts";

const ASSEMBLY: Curation = {
  kind: "assembly",
  pattern: "drafter-with-approval",
  phrasingSeed: "x",
  components: ["cwd-guard.ts", "stage-write.ts"],
  tag: "drafter-with-approval-x-01",
};

const GAP: Curation = {
  kind: "gap",
  pattern: "gap",
  phrasingSeed: "x",
  components: [],
  tag: "gap-x-01",
  closestMatch: "none",
};

/* ---------- forbiddenTokens ----------------------------------------- */

describe("forbiddenTokens", () => {
  it("includes the always-on pi-vocabulary tokens", () => {
    const toks = forbiddenTokens(ASSEMBLY);
    for (const expected of [
      "stage",
      "emit-summary",
      "emit_summary",
      "cwd-guard",
      "scout",
      "orchestrator",
      "recon",
      "confined",
      "drafter",
      "stub",
      "harvest",
      "pi extension",
      "pi-extension",
      "--tools",
      "stage_write",
      "run_deferred_writer",
    ]) {
      assert.ok(toks.includes(expected), `expected ${expected} in forbiddenTokens`);
    }
  });

  it("appends the assembly pattern name", () => {
    const toks = forbiddenTokens(ASSEMBLY);
    assert.ok(toks.includes("drafter-with-approval"));
  });

  it("does NOT append 'gap' as a forbidden token for gap curations", () => {
    // The `gap` pattern label is internal-only; user prompts saying
    // "gap" wouldn't be a leak, so the implementation skips it.
    const toks = forbiddenTokens(GAP);
    assert.equal(toks.includes("gap"), false);
  });

  it("appends each component filename minus extension, plus an underscore variant", () => {
    const toks = forbiddenTokens(ASSEMBLY);
    assert.ok(toks.includes("cwd-guard"));
    assert.ok(toks.includes("cwd_guard"));
    assert.ok(toks.includes("stage-write"));
    assert.ok(toks.includes("stage_write"));
    // The .ts suffix should never appear in the forbidden list.
    assert.equal(toks.some((t) => t.endsWith(".ts")), false);
  });

  it("returns lowercase, deduplicated tokens", () => {
    const toks = forbiddenTokens(ASSEMBLY);
    for (const t of toks) assert.equal(t, t.toLowerCase());
    assert.equal(toks.length, new Set(toks).size, "tokens must be unique");
  });

  it("for a gap curation with no components, returns just the always-on set", () => {
    const toks = forbiddenTokens(GAP);
    // Sanity: still has the always-on vocabulary.
    assert.ok(toks.includes("recon"));
    assert.ok(toks.includes("orchestrator"));
    // No component-derived tokens.
    assert.equal(toks.includes("cwd-guard"), true); // cwd-guard is always-on
    // …but no pattern-name token from `pattern: "gap"`.
    assert.equal(toks.includes("gap"), false);
  });
});

/* ---------- extractFinalMessage ------------------------------------- */

function ndjson(...events: Array<Record<string, unknown>>): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

describe("extractFinalMessage", () => {
  it("returns the text of the last message_end event", () => {
    const stream = ndjson(
      { type: "turn_start" },
      {
        type: "message_end",
        message: { content: [{ type: "text", text: "first" }] },
      },
      { type: "turn_end" },
      {
        type: "message_end",
        message: { content: [{ type: "text", text: "final answer" }] },
      },
    );
    assert.equal(extractFinalMessage(stream), "final answer");
  });

  it("trims whitespace around the final message", () => {
    const stream = ndjson({
      type: "message_end",
      message: { content: [{ type: "text", text: "  hello\n" }] },
    });
    assert.equal(extractFinalMessage(stream), "hello");
  });

  it("walks past message_end events with no extractable text", () => {
    const stream = ndjson(
      {
        type: "message_end",
        message: { content: [{ type: "text", text: "earlier" }] },
      },
      // Final message_end has empty content — extractor must walk
      // backwards to the prior one.
      { type: "message_end", message: { content: [] } },
    );
    assert.equal(extractFinalMessage(stream), "earlier");
  });

  it("ignores malformed JSON lines mid-stream", () => {
    const stream = [
      "{ not json",
      JSON.stringify({
        type: "message_end",
        message: { content: [{ type: "text", text: "ok" }] },
      }),
      "also garbage",
    ].join("\n");
    assert.equal(extractFinalMessage(stream), "ok");
  });

  it("throws when no extractable assistant message exists", () => {
    const stream = ndjson(
      { type: "turn_start" },
      { type: "tool_execution_start", toolName: "x", args: {} },
    );
    assert.throws(() => extractFinalMessage(stream), /Could not extract final assistant message/);
  });

  it("throws on completely empty stdout", () => {
    assert.throws(() => extractFinalMessage(""), /Could not extract final assistant message/);
  });

  it("ignores message_end events whose message field is missing", () => {
    const stream = ndjson(
      { type: "message_end" /* no message */ },
      {
        type: "message_end",
        message: { content: [{ type: "text", text: "found" }] },
      },
    );
    assert.equal(extractFinalMessage(stream), "found");
  });
});

/* ---------- flattenContent ------------------------------------------ */

describe("flattenContent", () => {
  it("returns a string content unchanged", () => {
    assert.equal(flattenContent("hi"), "hi");
  });

  it("joins string-only arrays", () => {
    assert.equal(flattenContent(["hello", " ", "world"]), "hello world");
  });

  it("extracts .text from {type, text} blocks", () => {
    assert.equal(
      flattenContent([
        { type: "text", text: "alpha" },
        { type: "text", text: "beta" },
      ]),
      "alphabeta",
    );
  });

  it("handles a mixed array of strings and text blocks", () => {
    assert.equal(
      flattenContent(["pre ", { type: "text", text: "mid" }, " post"]),
      "pre mid post",
    );
  });

  it("ignores blocks without a string .text", () => {
    assert.equal(
      flattenContent([
        { type: "text", text: 42 },
        { type: "image", source: "..." },
        { type: "text", text: "real" },
      ]),
      "real",
    );
  });

  it("returns empty string for non-array, non-string content", () => {
    assert.equal(flattenContent(undefined), "");
    assert.equal(flattenContent(null), "");
    assert.equal(flattenContent(42), "");
    assert.equal(flattenContent({ text: "nope" }), "");
  });

  it("returns empty string for an empty array", () => {
    assert.equal(flattenContent([]), "");
  });
});
