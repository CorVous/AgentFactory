// dispatch-agent.test.ts — unit tests for the dispatch_agent stub
// + parent-side. The component's parent-side `finalize` shells out
// to runSpec / delegate, which spawn a real `pi` child. Those code
// paths are NOT exercised here — they require an LLM round-trip.
// What IS tested:
//   - tool execute() returns the staged-intent payload
//   - harvest captures dispatch intents from tool_execution_start
//   - finalize's name-resolution branches:
//       * unknown YAML name → ok: false with "no such agent" summary
//       * malformed name (non-string) → ok: false
//       * empty composer args → ok: false (no spawn)
//       * unknown composer skill dir → ok: false (no spawn)
//   - successful YAML lookup happy path is NOT directly tested
//     (would require spawning pi); validateSpec acceptance proves
//     the spec was parsed before runSpec was reached.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import dispatchAgentFactory, {
  parentSide as DISPATCH_AGENT,
} from "../dispatch-agent.ts";
import type {
  DispatchAgentResult,
  DispatchAgentState,
  FinalizeContext,
  NDJSONEvent,
} from "../_parent-side.ts";

/* ---------- helpers --------------------------------------------------- */

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
}

function loadTool(): CapturedTool {
  let captured: CapturedTool | undefined;
  const stub = {
    registerTool: (def: unknown) => {
      captured = def as CapturedTool;
    },
  } as unknown as Parameters<typeof dispatchAgentFactory>[0];
  dispatchAgentFactory(stub);
  if (!captured) throw new Error("factory did not register a tool");
  return captured;
}

function toolStart(args: { name: string; toolArgs: string }): NDJSONEvent {
  return {
    type: "tool_execution_start",
    toolName: "dispatch_agent",
    args: { name: args.name, args: args.toolArgs },
  };
}

interface FctxStub extends FinalizeContext {
  ctx: FinalizeContext["ctx"];
  notifyCalls: Array<{ message: string; level: string }>;
}

function makeFctx(sandboxRoot: string): FctxStub {
  const notifyCalls: Array<{ message: string; level: string }> = [];
  const ctx: FinalizeContext["ctx"] = {
    hasUI: true,
    ui: {
      notify: (m, l) => {
        notifyCalls.push({ message: m, level: l });
      },
      confirm: async () => true,
    },
  };
  return { ctx, sandboxRoot, notifyCalls };
}

let SANDBOX: string;

before(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-agent-test-"));
});

after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe any pre-existing agents dir so unknown-name tests see a
  // truly empty registry.
  const agents = path.join(SANDBOX, ".pi", "agents");
  if (fs.existsSync(agents)) fs.rmSync(agents, { recursive: true, force: true });
});

/* ---------- child-side stub ------------------------------------------ */

describe("dispatch_agent tool execute()", () => {
  it("returns the staged-intent payload without doing real work", async () => {
    const tool = loadTool();
    const result = await tool.execute("c1", {
      name: "my-drafter",
      args: "draft a README",
    });
    assert.equal(result.details.name, "my-drafter");
    assert.equal(result.details.args, "draft a README");
    assert.equal(result.details.dispatched, true);
    assert.match(result.content[0].text, /Dispatched my-drafter/);
  });

  it("echoes args verbatim including empty string", async () => {
    const tool = loadTool();
    const result = await tool.execute("c2", { name: "x", args: "" });
    assert.equal(result.details.args, "");
  });
});

/* ---------- parentSide harvest -------------------------------------- */

describe("dispatch-agent parentSide harvest", () => {
  it("captures one dispatch intent per tool_execution_start", () => {
    const state: DispatchAgentState = DISPATCH_AGENT.initialState();
    DISPATCH_AGENT.harvest(
      toolStart({ name: "alpha", toolArgs: "first" }),
      state,
    );
    DISPATCH_AGENT.harvest(
      toolStart({ name: "beta", toolArgs: "second" }),
      state,
    );
    assert.equal(state.requests.length, 2);
    assert.equal(state.requests[0].name, "alpha");
    assert.equal(state.requests[0].args, "first");
    assert.equal(state.requests[1].name, "beta");
    assert.equal(state.requests[1].args, "second");
  });

  it("ignores unrelated tool events and non-start events", () => {
    const state: DispatchAgentState = DISPATCH_AGENT.initialState();
    DISPATCH_AGENT.harvest(
      {
        type: "tool_execution_end",
        toolName: "dispatch_agent",
        result: { details: { name: "x", args: "y", dispatched: true } },
      } as NDJSONEvent,
      state,
    );
    DISPATCH_AGENT.harvest(
      {
        type: "tool_execution_start",
        toolName: "stage_write",
        args: { path: "x", content: "y" },
      } as NDJSONEvent,
      state,
    );
    DISPATCH_AGENT.harvest({ type: "message_end" } as NDJSONEvent, state);
    assert.equal(state.requests.length, 0);
  });

  it("records malformed args as raw values for finalize to filter", () => {
    const state: DispatchAgentState = DISPATCH_AGENT.initialState();
    DISPATCH_AGENT.harvest(
      {
        type: "tool_execution_start",
        toolName: "dispatch_agent",
        args: { name: 42, args: ["bad"] },
      } as NDJSONEvent,
      state,
    );
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].name, 42);
    assert.deepEqual(state.requests[0].args, ["bad"]);
  });
});

/* ---------- parentSide finalize: error branches --------------------- */

describe("dispatch-agent parentSide finalize — error branches", () => {
  it("returns ok:false when name is non-string", async () => {
    const state: DispatchAgentState = DISPATCH_AGENT.initialState();
    state.requests.push({ name: 42, args: "x" });
    state.requests.push({ name: undefined, args: "y" });
    const fc = makeFctx(SANDBOX);
    const result = (await DISPATCH_AGENT.finalize(
      state,
      fc,
    )) as DispatchAgentResult;
    assert.equal(result.dispatches.length, 2);
    for (const d of result.dispatches) {
      assert.equal(d.ok, false);
      assert.match(d.summary, /invalid name/);
    }
  });

  it("returns ok:false with available list when YAML agent doesn't exist", async () => {
    const state: DispatchAgentState = DISPATCH_AGENT.initialState();
    state.requests.push({ name: "no-such-agent", args: "" });
    const fc = makeFctx(SANDBOX);
    const result = (await DISPATCH_AGENT.finalize(
      state,
      fc,
    )) as DispatchAgentResult;
    assert.equal(result.dispatches.length, 1);
    assert.equal(result.dispatches[0].ok, false);
    assert.equal(result.dispatches[0].name, "no-such-agent");
    assert.match(result.dispatches[0].summary, /no such agent/);
    assert.match(result.dispatches[0].summary, /Available:/);
    assert.match(result.dispatches[0].summary, /composer/);
  });

  it("lists available agents in error summary when registry is non-empty", async () => {
    const agentsDir = path.join(SANDBOX, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "alpha.yml"), "x: 1\n");
    fs.writeFileSync(path.join(agentsDir, "beta.yml"), "x: 1\n");

    const state: DispatchAgentState = DISPATCH_AGENT.initialState();
    state.requests.push({ name: "missing", args: "" });
    const fc = makeFctx(SANDBOX);
    const result = (await DISPATCH_AGENT.finalize(
      state,
      fc,
    )) as DispatchAgentResult;
    assert.equal(result.dispatches[0].ok, false);
    assert.match(result.dispatches[0].summary, /alpha/);
    assert.match(result.dispatches[0].summary, /beta/);
  });

  it("rejects names that escape the agents directory via path traversal", async () => {
    const state: DispatchAgentState = DISPATCH_AGENT.initialState();
    state.requests.push({ name: "../../etc/passwd", args: "" });
    const fc = makeFctx(SANDBOX);
    const result = (await DISPATCH_AGENT.finalize(
      state,
      fc,
    )) as DispatchAgentResult;
    assert.equal(result.dispatches.length, 1);
    assert.equal(result.dispatches[0].ok, false);
    // The path-validator (cwd-guard.validate) trips first; either
    // the validator or the directory-containment check fails.
    assert.match(
      result.dispatches[0].summary,
      /escape|outside|invalid|escapes/i,
    );
  });

  it("rejects YAML that fails validateSpec (not enough fields)", async () => {
    const agentsDir = path.join(SANDBOX, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "broken.yml"),
      "name: broken\n", // missing slash, description, composition, phases
    );

    const state: DispatchAgentState = DISPATCH_AGENT.initialState();
    state.requests.push({ name: "broken", args: "" });
    const fc = makeFctx(SANDBOX);
    const result = (await DISPATCH_AGENT.finalize(
      state,
      fc,
    )) as DispatchAgentResult;
    assert.equal(result.dispatches[0].ok, false);
    assert.match(result.dispatches[0].summary, /invalid|missing/);
  });

  it("rejects malformed YAML at parse time", async () => {
    const agentsDir = path.join(SANDBOX, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "garbled.yml"),
      "this is :: invalid : yaml :::\n  - [not closed\n",
    );

    const state: DispatchAgentState = DISPATCH_AGENT.initialState();
    state.requests.push({ name: "garbled", args: "" });
    const fc = makeFctx(SANDBOX);
    const result = (await DISPATCH_AGENT.finalize(
      state,
      fc,
    )) as DispatchAgentResult;
    assert.equal(result.dispatches[0].ok, false);
    assert.match(result.dispatches[0].summary, /parse error|invalid/);
  });
});

/* ---------- parentSide finalize: composer virtual entry ------------- */

describe("dispatch-agent parentSide finalize — composer virtual entry", () => {
  it("rejects empty composer args without attempting a spawn", async () => {
    const state: DispatchAgentState = DISPATCH_AGENT.initialState();
    state.requests.push({ name: "composer", args: "" });
    state.requests.push({ name: "composer", args: "   " });
    const fc = makeFctx(SANDBOX);
    const result = (await DISPATCH_AGENT.finalize(
      state,
      fc,
    )) as DispatchAgentResult;
    assert.equal(result.dispatches.length, 2);
    for (const d of result.dispatches) {
      assert.equal(d.ok, false);
      assert.equal(d.name, "composer");
      assert.match(d.summary, /non-empty `args`/);
    }
  });

  it("rejects composer dispatch when skill dir is missing", async () => {
    // SANDBOX has no skills/pi-agent-composer/ directory.
    const state: DispatchAgentState = DISPATCH_AGENT.initialState();
    state.requests.push({ name: "composer", args: "design something" });
    const fc = makeFctx(SANDBOX);
    const result = (await DISPATCH_AGENT.finalize(
      state,
      fc,
    )) as DispatchAgentResult;
    assert.equal(result.dispatches.length, 1);
    assert.equal(result.dispatches[0].ok, false);
    assert.equal(result.dispatches[0].name, "composer");
    assert.match(
      result.dispatches[0].summary,
      /composer skill not found/,
    );
  });
});

/* ---------- parentSide shape pin ------------------------------------- */

describe("dispatch-agent parentSide", () => {
  it("declares the canonical name and tool token", () => {
    assert.equal(DISPATCH_AGENT.name, "dispatch-agent");
    assert.deepEqual(DISPATCH_AGENT.tools, ["dispatch_agent"]);
  });

  it("contributes the dispatch-agent.ts -e flag to spawnArgs", () => {
    const eIndex = DISPATCH_AGENT.spawnArgs.indexOf("-e");
    assert.notEqual(eIndex, -1);
    const filePath = DISPATCH_AGENT.spawnArgs[eIndex + 1];
    assert.match(filePath, /dispatch-agent\.ts$/);
  });

  it("env() is empty (no env vars beyond what cwd-guard provides)", () => {
    assert.deepEqual(DISPATCH_AGENT.env({ cwd: SANDBOX }), {});
  });
});
