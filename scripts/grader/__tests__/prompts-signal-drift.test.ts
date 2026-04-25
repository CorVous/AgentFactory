// prompts-signal-drift.test.ts — guard against drift between the
// hand-mirrored SIGNAL_MAP (`scripts/grader/lib/signal-map.ts`) and
// the human-edited signal table in
// `pi-sandbox/skills/pi-agent-builder/references/reading-short-prompts.md`.
//
// Closes `parts-first-plan/60-open-questions.md §4` — option (a):
// hand-mirrored map + drift test (no build-time codegen).
//
// The markdown table contains signal phrases for a mix of *composer
// components* (stage-write, emit-summary, cwd-guard, review,
// run-deferred-writer) and *pi rails* that don't have a component
// mapping (AbortSignal, registerCommand, tool allowlists, etc.). Only
// the component-facing rows need to round-trip through SIGNAL_MAP; the
// others are out of scope for the prompt validator.
//
// Approach: pin a set of canonical prompt fragments that each represent
// one component signal. For every fragment, assert two invariants:
//   1. The fragment still appears in reading-short-prompts.md (so the
//      markdown hasn't dropped or reworded the signal).
//   2. SIGNAL_MAP still matches the fragment to the expected component
//      set (so the hand-mirror hasn't drifted).
//
// Adding a new signal to reading-short-prompts.md that maps to an
// existing or new component? Add a fragment here. Removing one? Remove
// the fragment. The test is meant to force a deliberate touch of this
// file whenever the signal surface changes.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  SIGNAL_MAP,
  inferComponentsFromPrompt,
} from "../lib/signal-map.ts";
import type { ComponentName } from "../lib/component-spec.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MD_PATH = path.resolve(
  HERE,
  "../../../pi-sandbox/skills/pi-agent-builder/references/reading-short-prompts.md",
);

/** Canonical fragments — one per component-facing signal row in the
 *  markdown table. Each fragment MUST match its expected components
 *  via SIGNAL_MAP; the fragment text MUST appear verbatim in the md
 *  (substring match, lowercased).
 *
 *  Fragments are deliberately kept short and verbatim from the table's
 *  quoted examples so a typo in either surface breaks the test. */
const FRAGMENTS: ReadonlyArray<{
  fragment: string;
  components: ReadonlyArray<ComponentName>;
  rowDescription: string;
}> = [
  {
    fragment: "produces a summary",
    components: ["emit-summary"],
    rowDescription: "recon / read-only / survey",
  },
  {
    fragment: "show me the draft before saving",
    components: ["stage-write"],
    rowDescription: "approval gate over drafts",
  },
  {
    fragment: "waits for the user to approve before the writes go through",
    components: ["stage-write"],
    rowDescription: "buffered / staged writes",
  },
  {
    fragment: "sandboxed to",
    components: ["cwd-guard"],
    rowDescription: "sandbox / confined writes",
  },
  {
    fragment: "surveys x, then drafts y",
    components: ["emit-summary", "stage-write"],
    rowDescription: "sequential scout + draft phases",
  },
  {
    fragment: "in parallel",
    components: ["run-deferred-writer"],
    rowDescription: "parallel drafter fan-out",
  },
  {
    fragment: "reviewer approves or revises",
    components: ["review", "run-deferred-writer"],
    rowDescription: "orchestrator with LLM review",
  },
];

describe("SIGNAL_MAP ↔ reading-short-prompts.md drift", () => {
  it("every canonical fragment still appears in the markdown", () => {
    const md = fs.readFileSync(MD_PATH, "utf8").toLowerCase();
    const missing = FRAGMENTS.filter((f) => !md.includes(f.fragment.toLowerCase()));
    assert.deepEqual(
      missing.map((m) => `[${m.rowDescription}] "${m.fragment}"`),
      [],
      "markdown drifted — these fragments were removed or reworded. " +
        "Update reading-short-prompts.md or update the fragments in this test.",
    );
  });

  it("every canonical fragment maps to the expected components via SIGNAL_MAP", () => {
    for (const { fragment, components, rowDescription } of FRAGMENTS) {
      const inferred = inferComponentsFromPrompt(fragment);
      for (const c of components) {
        assert.ok(
          inferred.has(c),
          `[${rowDescription}] fragment "${fragment}" should infer ${c}, ` +
            `got {${[...inferred].join(",")}}. SIGNAL_MAP drifted from the markdown.`,
        );
      }
    }
  });

  it("SIGNAL_MAP rows are each triggered by at least one canonical fragment", () => {
    // This guards the inverse: if someone adds a row to SIGNAL_MAP with
    // no corresponding markdown-anchored fragment, the row has nothing
    // keeping its regex honest.
    //
    // Known exception: the single-drafter LLM review row (components:
    // ["review"] alone, description "single-drafter LLM review") is a
    // composer-specific shape that doesn't have a matching markdown row
    // today — the orchestrator row in the markdown covers the
    // fan-out-plus-review case; the non-fan-out case is captured only
    // in composer's rails.md. Excluded by description.
    const KNOWN_EXCEPTIONS = new Set(["single-drafter LLM review"]);

    for (const row of SIGNAL_MAP) {
      if (KNOWN_EXCEPTIONS.has(row.description)) continue;
      const triggered = FRAGMENTS.some((f) => row.pattern.test(f.fragment));
      assert.ok(
        triggered,
        `SIGNAL_MAP row "${row.description}" has no canonical fragment. ` +
          "Add a fragment to the FRAGMENTS table or mark this row as a known exception.",
      );
    }
  });
});
