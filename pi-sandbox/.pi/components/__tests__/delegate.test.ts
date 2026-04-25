// delegate.test.ts — fixture-driven tests for each component's parentSide
// harvest+finalize contract. The delegate() runtime dispatches every
// parsed NDJSON line to every component's harvest, then runs each
// finalize once after the child closes. Both callbacks are pure (no
// spawn coupling), so we can drive them directly from fixture event
// arrays — no child process needed.
//
// These tests cover the core Phase 2 guarantee: a known NDJSON stream
// produces a known harvested + finalized state, deterministically.
// Absorbs §50 pass criterion #7 (canonical-extension behavior
// preserved): the determinism case asserts byte-equal plans and shas
// across identical fixture runs.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import { parentSide as STAGE_WRITE } from "../stage-write.ts";
import { parentSide as EMIT_SUMMARY } from "../emit-summary.ts";
import { parentSide as EMIT_AGENT_SPEC } from "../emit-agent-spec.ts";
import { parentSide as REVIEW } from "../review.ts";
import { parentSide as RUN_DEFERRED_WRITER } from "../run-deferred-writer.ts";
import type {
  EmitAgentSpecResult,
  EmitAgentSpecState,
  EmitSummaryResult,
  EmitSummaryState,
  NDJSONEvent,
  ReviewResult,
  ReviewState,
  StageWriteResult,
  StageWriteState,
  DispatchRequestsResult,
  DispatchRequestsState,
  FinalizeContext,
} from "../_parent-side.ts";

const sha256 = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex");

function toolStart(toolName: string, args: Record<string, unknown>): NDJSONEvent {
  return { type: "tool_execution_start", toolName, args };
}

function fctx(sandboxRoot: string): FinalizeContext {
  return {
    ctx: { ui: { notify: () => {} } },
    sandboxRoot,
  };
}

let SANDBOX: string;

before(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-"));
});

after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/* -------- stage-write ---------------------------------------------- */

describe("stage-write parentSide", () => {
  it("harvests valid relative paths into StagedWritePlans with stable shas", async () => {
    const state: StageWriteState = STAGE_WRITE.initialState();
    const events = [
      toolStart("stage_write", { path: "out/a.md", content: "alpha" }),
      toolStart("stage_write", { path: "out/b.md", content: "beta" }),
      toolStart("stage_write", { path: "out/c.md", content: "gamma" }),
    ];
    for (const e of events) STAGE_WRITE.harvest(e, state);
    const result = (await STAGE_WRITE.finalize(state, fctx(SANDBOX))) as StageWriteResult;

    assert.equal(result.plans.length, 3);
    assert.deepEqual(result.skips, []);
    assert.equal(result.plans[0].relPath, "out/a.md");
    assert.equal(result.plans[0].destAbs, path.resolve(SANDBOX, "out/a.md"));
    assert.equal(result.plans[0].sha, sha256("alpha"));
    assert.equal(result.plans[1].sha, sha256("beta"));
    assert.equal(result.plans[2].byteLength, Buffer.byteLength("gamma", "utf8"));
  });

  it("rejects absolute paths, .. segments, existing destinations, oversized content", async () => {
    // Create a file to collide against.
    const collide = path.join(SANDBOX, "exists.md");
    fs.writeFileSync(collide, "already here");

    const state: StageWriteState = STAGE_WRITE.initialState();
    const events = [
      toolStart("stage_write", { path: "/etc/passwd", content: "x" }),
      toolStart("stage_write", { path: "../escape.md", content: "x" }),
      toolStart("stage_write", { path: "sub/../escape.md", content: "x" }),
      toolStart("stage_write", { path: "exists.md", content: "x" }),
      toolStart("stage_write", { path: "big.bin", content: "x".repeat(2_000_001) }),
      toolStart("stage_write", { path: "", content: "x" }),
      toolStart("stage_write", { path: "ok.md", content: 42 }),
    ];
    for (const e of events) STAGE_WRITE.harvest(e, state);
    const result = (await STAGE_WRITE.finalize(state, fctx(SANDBOX))) as StageWriteResult;

    assert.equal(result.plans.length, 0);
    // Each bad input should produce exactly one skip.
    assert.equal(result.skips.length, 7, result.skips.join(" | "));
    assert.ok(result.skips.some((s) => s.includes("absolute")));
    assert.ok(result.skips.some((s) => s.includes("destination exists")));
    assert.ok(result.skips.some((s) => s.includes("> 2000000 limit")));
  });

  it("ignores non-stage_write events and events without args", () => {
    const state: StageWriteState = STAGE_WRITE.initialState();
    STAGE_WRITE.harvest({ type: "message_end" }, state);
    STAGE_WRITE.harvest(toolStart("emit_summary", { title: "t", body: "b" }), state);
    STAGE_WRITE.harvest({ type: "tool_execution_start", toolName: "stage_write" }, state);
    assert.equal(state.stagedWrites.length, 0);
  });
});

/* -------- emit-summary --------------------------------------------- */

describe("emit-summary parentSide", () => {
  it("accepts bodies under the byte cap and surfaces skips for oversized", async () => {
    const state: EmitSummaryState = EMIT_SUMMARY.initialState();
    const events = [
      toolStart("emit_summary", { title: "one", body: "first body" }),
      toolStart("emit_summary", { title: "two", body: "second body" }),
      toolStart("emit_summary", { title: "big", body: "x".repeat(8_193) }),
      toolStart("emit_summary", { title: "", body: "no-title" }),
      toolStart("emit_summary", { title: "no-body", body: 99 }),
    ];
    for (const e of events) EMIT_SUMMARY.harvest(e, state);
    const result = (await EMIT_SUMMARY.finalize(state, fctx(SANDBOX))) as EmitSummaryResult;

    assert.equal(result.summaries.length, 2);
    assert.deepEqual(
      result.summaries.map((s) => s.title),
      ["one", "two"],
    );
    assert.equal(result.skips.length, 3);
    assert.ok(result.skips.some((s) => s.includes("> 8192 limit")));
  });
});

/* -------- review --------------------------------------------------- */

describe("review parentSide", () => {
  it("last verdict per file_path wins in verdictMap; reviews[] keeps insertion order", async () => {
    const state: ReviewState = REVIEW.initialState();
    const events = [
      toolStart("review", { file_path: "a.md", verdict: "revise", feedback: "more detail" }),
      toolStart("review", { file_path: "b.md", verdict: "approve" }),
      toolStart("review", { file_path: "a.md", verdict: "approve" }),
      toolStart("review", { file_path: "c.md", verdict: "revise" }),
    ];
    for (const e of events) REVIEW.harvest(e, state);
    const result = (await REVIEW.finalize(state, fctx(SANDBOX))) as ReviewResult;

    assert.equal(result.reviews.length, 4);
    assert.equal(result.reviews[0].file_path, "a.md");
    assert.equal(result.reviews[0].verdict, "revise");
    assert.equal(result.verdictMap.size, 3);
    assert.equal(result.verdictMap.get("a.md")!.verdict, "approve");
    assert.equal(result.verdictMap.get("b.md")!.verdict, "approve");
    assert.equal(result.verdictMap.get("c.md")!.verdict, "revise");
  });

  it("treats unknown verdict strings as 'revise' (defensive)", () => {
    const state: ReviewState = REVIEW.initialState();
    REVIEW.harvest(
      toolStart("review", { file_path: "x.md", verdict: "needs-work" }),
      state,
    );
    assert.equal(state.reviews[0].verdict, "revise");
  });
});

/* -------- run-deferred-writer -------------------------------------- */

describe("run-deferred-writer parentSide", () => {
  it("accumulates tasks in dispatch order", async () => {
    const state: DispatchRequestsState = RUN_DEFERRED_WRITER.initialState();
    for (const t of ["write a.md", "write b.md", "write c.md"]) {
      RUN_DEFERRED_WRITER.harvest(
        toolStart("run_deferred_writer", { task: t }),
        state,
      );
    }
    const result = (await RUN_DEFERRED_WRITER.finalize(
      state,
      fctx(SANDBOX),
    )) as DispatchRequestsResult;
    assert.deepEqual(result.tasks, ["write a.md", "write b.md", "write c.md"]);
    // finalize returns a copy, not the internal state array.
    assert.notStrictEqual(result.tasks, state.tasks);
  });

  it("skips events missing a string task arg", () => {
    const state: DispatchRequestsState = RUN_DEFERRED_WRITER.initialState();
    RUN_DEFERRED_WRITER.harvest(toolStart("run_deferred_writer", {}), state);
    RUN_DEFERRED_WRITER.harvest(toolStart("run_deferred_writer", { task: 42 }), state);
    assert.equal(state.tasks.length, 0);
  });
});

/* -------- emit-agent-spec ------------------------------------------ */

describe("emit-agent-spec parentSide", () => {
  it("records the spec name on a successful emit_agent_spec call and verifies the file exists at finalize", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emit-spec-test-"));
    try {
      const agentsDir = path.join(root, ".pi", "agents");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, "demo.yml"), "name: demo\n");

      const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
      EMIT_AGENT_SPEC.harvest(
        toolStart("emit_agent_spec", { name: "demo", slash: "demo" }),
        state,
      );
      const result = (await EMIT_AGENT_SPEC.finalize(
        state,
        fctx(root),
      )) as EmitAgentSpecResult;

      assert.equal(result.wrote, true);
      assert.equal(result.name, "demo");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports wrote=false when the on-disk file is missing after the call", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emit-spec-test-"));
    try {
      const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
      EMIT_AGENT_SPEC.harvest(
        toolStart("emit_agent_spec", { name: "ghost", slash: "ghost" }),
        state,
      );
      const result = (await EMIT_AGENT_SPEC.finalize(
        state,
        fctx(root),
      )) as EmitAgentSpecResult;

      assert.equal(result.wrote, false);
      assert.equal(result.name, "ghost");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores unrelated events and emit_agent_spec calls without a string name", async () => {
    const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
    EMIT_AGENT_SPEC.harvest({ type: "message_end" }, state);
    EMIT_AGENT_SPEC.harvest(
      toolStart("emit_summary", { title: "t", body: "b" }),
      state,
    );
    EMIT_AGENT_SPEC.harvest(
      toolStart("emit_agent_spec", { name: 42 }),
      state,
    );
    // Last call recorded wrote=true (we saw the tool fire) but name remains
    // undefined because the args.name was not a string.
    assert.equal(state.wrote, true);
    assert.equal(state.name, undefined);

    const result = (await EMIT_AGENT_SPEC.finalize(
      state,
      fctx(SANDBOX),
    )) as EmitAgentSpecResult;
    assert.equal(result.wrote, false);
    assert.equal(result.name, undefined);
  });
});

/* -------- NDJSON-level robustness ---------------------------------- */

describe("harvest loop robustness", () => {
  it("malformed NDJSON lines don't block downstream events", () => {
    // Simulate delegate()'s per-line JSON.parse + continue-on-error loop.
    const lines = [
      "",
      "{ not json",
      JSON.stringify(toolStart("stage_write", { path: "x.md", content: "hi" })),
      "also garbage",
      JSON.stringify(toolStart("stage_write", { path: "y.md", content: "hey" })),
    ];
    const state: StageWriteState = STAGE_WRITE.initialState();
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: NDJSONEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      STAGE_WRITE.harvest(event, state);
    }
    assert.equal(state.stagedWrites.length, 2);
  });

  it("dispatching the same event to multiple components evolves each state independently", () => {
    const stageState: StageWriteState = STAGE_WRITE.initialState();
    const summaryState: EmitSummaryState = EMIT_SUMMARY.initialState();
    const reviewState: ReviewState = REVIEW.initialState();

    const events = [
      toolStart("stage_write", { path: "a.md", content: "alpha" }),
      toolStart("emit_summary", { title: "survey", body: "found 3 files" }),
      toolStart("review", { file_path: "a.md", verdict: "approve" }),
      toolStart("stage_write", { path: "b.md", content: "beta" }),
    ];
    for (const e of events) {
      STAGE_WRITE.harvest(e, stageState);
      EMIT_SUMMARY.harvest(e, summaryState);
      REVIEW.harvest(e, reviewState);
    }

    assert.equal(stageState.stagedWrites.length, 2);
    assert.equal(summaryState.summaries.length, 1);
    assert.equal(reviewState.reviews.length, 1);
  });
});

/* -------- Determinism (absorbs §50 pass criterion #7) -------------- */

describe("delegate determinism", () => {
  it("identical fixtures produce byte-equal plans + shas across runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-det-"));
    try {
      const events = [
        toolStart("stage_write", { path: "out/a.md", content: "alpha" }),
        toolStart("stage_write", { path: "out/b.md", content: "beta" }),
      ];

      const run = async (): Promise<StageWriteResult> => {
        const state = STAGE_WRITE.initialState();
        for (const e of events) STAGE_WRITE.harvest(e, state);
        return (await STAGE_WRITE.finalize(state, fctx(root))) as StageWriteResult;
      };

      const first = await run();
      const second = await run();

      assert.equal(first.plans.length, second.plans.length);
      for (let i = 0; i < first.plans.length; i++) {
        assert.equal(first.plans[i].relPath, second.plans[i].relPath);
        assert.equal(first.plans[i].content, second.plans[i].content);
        assert.equal(first.plans[i].sha, second.plans[i].sha);
        assert.equal(first.plans[i].byteLength, second.plans[i].byteLength);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("emit-summary finalize is deterministic across identical fixtures", async () => {
    const events = [
      toolStart("emit_summary", { title: "s1", body: "body-one" }),
      toolStart("emit_summary", { title: "s2", body: "body-two" }),
    ];
    const run = async (): Promise<EmitSummaryResult> => {
      const state = EMIT_SUMMARY.initialState();
      for (const e of events) EMIT_SUMMARY.harvest(e, state);
      return (await EMIT_SUMMARY.finalize(state, fctx(SANDBOX))) as EmitSummaryResult;
    };
    const first = await run();
    const second = await run();
    assert.deepEqual(first.summaries, second.summaries);
    assert.deepEqual(first.skips, second.skips);
  });
});
