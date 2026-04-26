// emit-agent-spec.test.ts — covers the tool-execute path and the
// pure validators in emit-agent-spec.ts. These tests are a strict
// superset of the `emit-agent-spec parentSide` block in delegate.test.ts:
// they re-cover the harvest+finalize contract AND add the previously
// untested tool-side rules (name/slash regex, phase-rule validation,
// path-escape guard, duplicate-file guard, YAML round-trip). Once this
// file lands, the emit-agent-spec section of delegate.test.ts is
// redundant and can be deleted.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { parse as yamlParse } from "yaml";

import emitAgentSpecFactory, {
  parentSide as EMIT_AGENT_SPEC,
  validateNames,
  validatePhases,
  COMPOSITION_NAMES,
} from "../emit-agent-spec.ts";
import type {
  EmitAgentSpecResult,
  EmitAgentSpecState,
  FinalizeContext,
  NDJSONEvent,
} from "../_parent-side.ts";

/* ---------- helpers --------------------------------------------------- */

interface ToolExecCtxStub {
  hasUI: boolean;
  ui: {
    notify: (m: string, level: "info" | "warning" | "error") => void;
    confirm: (title: string, body: string) => Promise<boolean>;
  };
  confirmCalls: Array<{ title: string; body: string }>;
}

/**
 * Build a stub `ExtensionContext` for `tool.execute()`'s 5th arg.
 * `hasUI` defaults to true (interactive composer session); pass
 * `hasUI: false` to drive the sub-agent / print-mode branch.
 * `confirm` defaults to auto-approve; pass `confirmAnswer: false`
 * to drive the deny path. Capture confirm-call args via
 * `result.confirmCalls` for assertion.
 */
function makeExecCtx(opts: {
  hasUI?: boolean;
  confirmAnswer?: boolean;
} = {}): ToolExecCtxStub {
  const calls: Array<{ title: string; body: string }> = [];
  return {
    hasUI: opts.hasUI ?? true,
    ui: {
      notify: () => {},
      confirm: async (title, body) => {
        calls.push({ title, body });
        return opts.confirmAnswer ?? true;
      },
    },
    confirmCalls: calls,
  };
}

function toolEnd(args: {
  toolName: string;
  result?: unknown;
  isError?: boolean;
}): NDJSONEvent {
  return {
    type: "tool_execution_end",
    toolName: args.toolName,
    result: args.result,
    isError: args.isError ?? false,
  };
}

interface FctxStub extends FinalizeContext {
  ctx: {
    hasUI: boolean;
    ui: {
      notify: (m: string, level: "info" | "warning" | "error") => void;
      confirm?: (title: string, body: string) => Promise<boolean>;
    };
  };
  notifyCalls: Array<{ message: string; level: string }>;
  confirmCalls: Array<{ title: string; body: string }>;
}

function makeFctx(
  sandboxRoot: string,
  opts: {
    hasUI?: boolean;
    confirmAnswers?: boolean[];
    omitConfirm?: boolean;
  } = {},
): FctxStub {
  const notifyCalls: Array<{ message: string; level: string }> = [];
  const confirmCalls: Array<{ title: string; body: string }> = [];
  const answers = [...(opts.confirmAnswers ?? [])];
  const ctx: FctxStub["ctx"] = {
    hasUI: opts.hasUI ?? true,
    ui: {
      notify: (message, level) => {
        notifyCalls.push({ message, level });
      },
      ...(opts.omitConfirm
        ? {}
        : {
            confirm: async (title, body) => {
              confirmCalls.push({ title, body });
              return answers.length > 0 ? (answers.shift() as boolean) : true;
            },
          }),
    },
  };
  return { ctx, sandboxRoot, notifyCalls, confirmCalls };
}

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
}

/**
 * Drive the default-exported factory with a stub ExtensionAPI that
 * captures whatever tool gets registered. Returns the captured tool
 * so tests can call its execute() directly without a child process.
 */
function loadTool(sandboxRoot: string): CapturedTool {
  process.env.PI_SANDBOX_ROOT = sandboxRoot;
  let captured: CapturedTool | undefined;
  const stub = {
    registerTool: (def: unknown) => {
      captured = def as CapturedTool;
    },
  } as unknown as Parameters<typeof emitAgentSpecFactory>[0];
  emitAgentSpecFactory(stub);
  if (!captured) throw new Error("factory did not register a tool");
  return captured;
}

/* ---------- test scaffolding ----------------------------------------- */

let SANDBOX: string;

before(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "emit-agent-spec-test-"));
});

after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  delete process.env.PI_SANDBOX_ROOT;
});

beforeEach(() => {
  // Clean any specs left by a previous test so duplicate-file guards
  // and listings don't accumulate state across runs.
  const dir = path.join(SANDBOX, ".pi", "agents");
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- validateNames -------------------------------------------- */

describe("validateNames", () => {
  it("accepts canonical lowercase-dash names", () => {
    assert.doesNotThrow(() => validateNames("ab", "ab"));
    assert.doesNotThrow(() => validateNames("agent-composer", "agent-composer"));
    assert.doesNotThrow(() => validateNames("a1-b2-c3", "a1-b2-c3"));
    assert.doesNotThrow(() =>
      // 41-char total: 1 leading letter + 40 trailing chars (regex max).
      validateNames("a" + "a".repeat(40), "a" + "b".repeat(40)),
    );
  });

  it("rejects uppercase, leading digit, special chars, empty, leading slash", () => {
    assert.throws(() => validateNames("Agent", "agent"), /name must match/);
    assert.throws(() => validateNames("agent", "Agent"), /slash must match/);
    assert.throws(() => validateNames("1agent", "agent"), /name must match/);
    assert.throws(() => validateNames("agent_x", "agent"), /name must match/);
    assert.throws(() => validateNames("agent.x", "agent"), /name must match/);
    assert.throws(() => validateNames("", "agent"), /name must match/);
    assert.throws(() => validateNames("agent", ""), /slash must match/);
    assert.throws(() => validateNames("agent", "/agent"), /slash must match/);
    assert.throws(() => validateNames("a", "a"), /name must match/); // 1-char too short
  });

  it("rejects names exceeding the 41-char regex ceiling", () => {
    const tooLong = "a" + "b".repeat(41); // 42 total
    assert.throws(() => validateNames(tooLong, "ok"), /name must match/);
    assert.throws(() => validateNames("ok", tooLong), /slash must match/);
  });
});

/* ---------- validatePhases ------------------------------------------- */

describe("validatePhases — single-spawn", () => {
  it("accepts exactly one phase", () => {
    assert.doesNotThrow(() =>
      validatePhases("single-spawn", [{ components: ["cwd-guard", "stage-write"] }]),
    );
  });

  it("rejects zero phases", () => {
    assert.throws(
      () => validatePhases("single-spawn", []),
      /single-spawn requires exactly 1 phase, got 0/,
    );
  });

  it("rejects two phases", () => {
    assert.throws(
      () =>
        validatePhases("single-spawn", [
          { components: ["emit-summary"] },
          { components: ["stage-write"] },
        ]),
      /single-spawn requires exactly 1 phase, got 2/,
    );
  });
});

describe("validatePhases — sequential-phases-with-brief", () => {
  it("accepts 2 phases when phase-1 has emit-summary and phase-2 has stage-write", () => {
    assert.doesNotThrow(() =>
      validatePhases("sequential-phases-with-brief", [
        { components: ["emit-summary"] },
        { components: ["cwd-guard", "stage-write"] },
      ]),
    );
  });

  it("rejects 1 phase", () => {
    assert.throws(
      () =>
        validatePhases("sequential-phases-with-brief", [
          { components: ["emit-summary"] },
        ]),
      /sequential-phases-with-brief requires exactly 2 phases, got 1/,
    );
  });

  it("rejects 3 phases", () => {
    assert.throws(
      () =>
        validatePhases("sequential-phases-with-brief", [
          { components: ["emit-summary"] },
          { components: ["stage-write"] },
          { components: ["stage-write"] },
        ]),
      /sequential-phases-with-brief requires exactly 2 phases, got 3/,
    );
  });

  it("rejects when phase-1 is missing emit-summary", () => {
    assert.throws(
      () =>
        validatePhases("sequential-phases-with-brief", [
          { components: ["cwd-guard"] },
          { components: ["stage-write"] },
        ]),
      /phase 1 must include `emit-summary`/,
    );
  });

  it("rejects when phase-2 is missing stage-write", () => {
    assert.throws(
      () =>
        validatePhases("sequential-phases-with-brief", [
          { components: ["emit-summary"] },
          { components: ["cwd-guard"] },
        ]),
      /phase 2 must include `stage-write`/,
    );
  });
});

describe("validatePhases — single-spawn-with-dispatch", () => {
  it("accepts a phase with dispatch-agent in components and dispatch_agent in tools", () => {
    assert.doesNotThrow(() =>
      validatePhases("single-spawn-with-dispatch", [
        { components: ["dispatch-agent"], tools: ["dispatch_agent"] },
      ]),
    );
  });

  it("rejects a phase without dispatch-agent in components", () => {
    assert.throws(
      () =>
        validatePhases("single-spawn-with-dispatch", [
          { components: ["stage-write"], tools: ["dispatch_agent", "stage_write"] },
        ]),
      /must include `dispatch-agent` in components/,
    );
  });

  it("rejects a phase without dispatch_agent in tools", () => {
    assert.throws(
      () =>
        validatePhases("single-spawn-with-dispatch", [
          { components: ["dispatch-agent"], tools: ["sandbox_ls"] },
        ]),
      /must include `dispatch_agent` in tools/,
    );
  });

  it("rejects a phase missing the tools field entirely", () => {
    assert.throws(
      () =>
        validatePhases("single-spawn-with-dispatch", [
          { components: ["dispatch-agent"] },
        ]),
      /must include `dispatch_agent` in tools/,
    );
  });

  it("rejects more than one phase", () => {
    assert.throws(
      () =>
        validatePhases("single-spawn-with-dispatch", [
          { components: ["dispatch-agent"], tools: ["dispatch_agent"] },
          { components: ["dispatch-agent"], tools: ["dispatch_agent"] },
        ]),
      /single-spawn-with-dispatch requires exactly 1 phase/,
    );
  });

  it("rejects dispatch-agent declared in single-spawn (wrong composition)", () => {
    assert.throws(
      () =>
        validatePhases("single-spawn", [
          { components: ["dispatch-agent"], tools: ["dispatch_agent"] },
        ]),
      /requires composition `single-spawn-with-dispatch`/,
    );
  });

  it("rejects dispatch-agent declared in sequential-phases-with-brief", () => {
    assert.throws(
      () =>
        validatePhases("sequential-phases-with-brief", [
          { components: ["emit-summary", "dispatch-agent"], tools: ["dispatch_agent"] },
          { components: ["stage-write"] },
        ]),
      /requires composition `single-spawn-with-dispatch`/,
    );
  });
});

describe("validatePhases — RPC-only components", () => {
  it("rejects review with a GAP-pointing message", () => {
    assert.throws(
      () => validatePhases("single-spawn", [{ components: ["review"] }]),
      /rpc-delegator topology|GAP/,
    );
  });

  it("rejects run-deferred-writer with a GAP-pointing message", () => {
    assert.throws(
      () =>
        validatePhases("single-spawn", [
          { components: ["run-deferred-writer"] },
        ]),
      /rpc-delegator topology|GAP/,
    );
  });

  it("rejects review even within an otherwise-valid sequential spec", () => {
    assert.throws(
      () =>
        validatePhases("sequential-phases-with-brief", [
          { components: ["emit-summary"] },
          { components: ["stage-write", "review"] },
        ]),
      /rpc-delegator topology|GAP/,
    );
  });
});

describe("validatePhases — unknown composition", () => {
  it("rejects an unknown composition string", () => {
    assert.throws(
      () =>
        validatePhases(
          "rpc-delegator-over-concurrent-drafters" as never,
          [{ components: ["cwd-guard"] }],
        ),
      /unknown composition/,
    );
  });
});

describe("COMPOSITION_NAMES", () => {
  it("exposes the canonical set the YAML composer accepts", () => {
    assert.deepEqual(
      [...COMPOSITION_NAMES].sort(),
      [
        "sequential-phases-with-brief",
        "single-spawn",
        "single-spawn-with-dispatch",
      ],
    );
  });
});

/* ---------- tool execute() — happy path & guards --------------------- */

describe("emit_agent_spec tool execute() — direct-mode (hasUI=true)", () => {
  it("writes a YAML file under <root>/.pi/agents/<name>.yml that round-trips after approve", async () => {
    const tool = loadTool(SANDBOX);
    const ctx = makeExecCtx();
    const params = {
      name: "demo-agent",
      slash: "demo",
      description: "Tiny demo composer agent",
      composition: "single-spawn",
      phases: [
        {
          name: "draft",
          components: ["cwd-guard", "stage-write"],
          prompt: "Hello {args} from {sandboxRoot}",
        },
      ],
    };
    const result = await tool.execute("call-1", params, undefined, undefined, ctx);

    const dest = path.join(SANDBOX, ".pi", "agents", "demo-agent.yml");
    assert.ok(fs.existsSync(dest), "expected YAML file on disk");
    assert.equal(result.details.name, "demo-agent");
    assert.equal(result.details.path, dest);
    assert.equal(result.details.composition, "single-spawn");
    assert.equal(result.details.staged, false);
    assert.match(result.content[0].text, /Wrote spec/);

    // Confirm dialog received the previewed YAML byte-for-byte.
    assert.equal(ctx.confirmCalls.length, 1);
    assert.match(ctx.confirmCalls[0].title, /Write composer spec/);
    assert.equal(
      ctx.confirmCalls[0].body,
      fs.readFileSync(dest, "utf8"),
    );

    const reloaded = yamlParse(fs.readFileSync(dest, "utf8"));
    assert.deepEqual(reloaded, params);
  });

  it("returns isError + details.cancelled when user denies, no file written", async () => {
    const tool = loadTool(SANDBOX);
    const ctx = makeExecCtx({ confirmAnswer: false });
    const params = {
      name: "denied-agent",
      slash: "denied",
      description: "x",
      composition: "single-spawn",
      phases: [{ components: ["cwd-guard"], prompt: "p" }],
    };
    const result = await tool.execute("call-1", params, undefined, undefined, ctx);

    assert.equal(result.isError, true);
    assert.equal(result.details.cancelled, true);
    assert.equal(result.details.reason, "denied");
    assert.equal(result.details.name, "denied-agent");
    assert.match(result.content[0].text, /Cancelled by user/);
    assert.equal(
      fs.existsSync(path.join(SANDBOX, ".pi", "agents", "denied-agent.yml")),
      false,
    );
    assert.equal(ctx.confirmCalls.length, 1);
  });

  it("path-escape guard rejects names that would resolve outside agents dir", async () => {
    const tool = loadTool(SANDBOX);
    const ctx = makeExecCtx();
    // The factory's name regex actually rejects `..` first via NAME_RE,
    // but we still want to prove no file lands outside the agents dir.
    await assert.rejects(
      tool.execute(
        "call-2",
        {
          name: "../escape",
          slash: "ok",
          description: "x",
          composition: "single-spawn",
          phases: [{ components: ["cwd-guard"], prompt: "p" }],
        },
        undefined,
        undefined,
        ctx,
      ),
      /name must match|path escapes/,
    );
    const escapeAt = path.join(SANDBOX, ".pi", "escape.yml");
    assert.equal(fs.existsSync(escapeAt), false);
    // Validation throws BEFORE the gate runs.
    assert.equal(ctx.confirmCalls.length, 0);
  });

  it("duplicate-file guard refuses to overwrite an existing spec", async () => {
    const tool = loadTool(SANDBOX);
    const ctx = makeExecCtx();
    const params = {
      name: "dup-agent",
      slash: "dup",
      description: "first emit",
      composition: "single-spawn",
      phases: [{ components: ["cwd-guard"], prompt: "first" }],
    };
    await tool.execute("c1", params, undefined, undefined, ctx);
    const dest = path.join(SANDBOX, ".pi", "agents", "dup-agent.yml");
    const firstYaml = fs.readFileSync(dest, "utf8");

    await assert.rejects(
      tool.execute(
        "c2",
        { ...params, description: "second emit" },
        undefined,
        undefined,
        ctx,
      ),
      /already exists/,
    );
    // Original content untouched.
    assert.equal(fs.readFileSync(dest, "utf8"), firstYaml);
  });

  it("name regex enforced through tool execute (catches stale params)", async () => {
    const tool = loadTool(SANDBOX);
    const ctx = makeExecCtx();
    await assert.rejects(
      tool.execute(
        "c3",
        {
          name: "BAD_NAME",
          slash: "ok",
          description: "x",
          composition: "single-spawn",
          phases: [{ components: ["cwd-guard"], prompt: "p" }],
        },
        undefined,
        undefined,
        ctx,
      ),
      /name must match/,
    );
    assert.equal(ctx.confirmCalls.length, 0);
  });

  it("phase rules enforced through tool execute (composer cannot bypass)", async () => {
    const tool = loadTool(SANDBOX);
    const ctx = makeExecCtx();
    await assert.rejects(
      tool.execute(
        "c4",
        {
          name: "phase-bad",
          slash: "phase",
          description: "x",
          composition: "sequential-phases-with-brief",
          phases: [
            { components: ["cwd-guard"], prompt: "scout" }, // missing emit-summary
            { components: ["stage-write"], prompt: "draft" },
          ],
        },
        undefined,
        undefined,
        ctx,
      ),
      /phase 1 must include `emit-summary`/,
    );
    assert.equal(
      fs.existsSync(path.join(SANDBOX, ".pi", "agents", "phase-bad.yml")),
      false,
    );
    assert.equal(ctx.confirmCalls.length, 0);
  });
});

describe("emit_agent_spec tool execute() — sub-agent / print-mode (hasUI=false)", () => {
  it("returns staged payload without writing or calling confirm", async () => {
    const tool = loadTool(SANDBOX);
    const ctx = makeExecCtx({ hasUI: false });
    const params = {
      name: "staged-agent",
      slash: "staged",
      description: "x",
      composition: "single-spawn",
      phases: [{ components: ["cwd-guard"], prompt: "p" }],
    };
    const result = await tool.execute(
      "call-1",
      params,
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details.staged, true);
    assert.equal(result.details.name, "staged-agent");
    assert.equal(result.details.slash, "staged");
    assert.equal(result.details.composition, "single-spawn");
    assert.equal(typeof result.details.yaml, "string");
    assert.match(result.content[0].text, /staged for parent review/);

    // No file landed; confirm was never called.
    assert.equal(
      fs.existsSync(path.join(SANDBOX, ".pi", "agents", "staged-agent.yml")),
      false,
    );
    assert.equal(ctx.confirmCalls.length, 0);
  });

  it("treats undefined ctx (legacy harnesses) as no-UI: stages, no write, no throw", async () => {
    const tool = loadTool(SANDBOX);
    const params = {
      name: "no-ctx-agent",
      slash: "noctx",
      description: "x",
      composition: "single-spawn",
      phases: [{ components: ["cwd-guard"], prompt: "p" }],
    };
    const result = await tool.execute("c5", params);

    assert.equal(result.details.staged, true);
    assert.equal(
      fs.existsSync(path.join(SANDBOX, ".pi", "agents", "no-ctx-agent.yml")),
      false,
    );
  });
});

/* ---------- parentSide harvest + finalize ---------------------------- */

describe("emit-agent-spec parentSide harvest", () => {
  it("ignores tool_execution_end with isError=true (cancelled / threw)", () => {
    const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
    EMIT_AGENT_SPEC.harvest(
      toolEnd({
        toolName: "emit_agent_spec",
        isError: true,
        result: {
          details: {
            name: "denied-agent",
            cancelled: true,
            reason: "denied",
            staged: false,
          },
        },
      }),
      state,
    );
    assert.equal(state.staged.length, 0);
    assert.equal(state.childWrote.length, 0);
  });

  it("pushes to staged when details.staged === true", () => {
    const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
    EMIT_AGENT_SPEC.harvest(
      toolEnd({
        toolName: "emit_agent_spec",
        result: {
          details: {
            name: "sub-agent",
            slash: "sub",
            composition: "single-spawn",
            yaml: "name: sub-agent\n",
            staged: true,
          },
        },
      }),
      state,
    );
    assert.equal(state.staged.length, 1);
    assert.equal(state.staged[0].name, "sub-agent");
    assert.equal(state.staged[0].slash, "sub");
    assert.equal(state.staged[0].composition, "single-spawn");
    assert.equal(state.staged[0].yaml, "name: sub-agent\n");
    assert.equal(state.childWrote.length, 0);
  });

  it("pushes to childWrote when details.staged === false (direct-mode write)", () => {
    const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
    EMIT_AGENT_SPEC.harvest(
      toolEnd({
        toolName: "emit_agent_spec",
        result: {
          details: {
            name: "direct-write",
            path: "/abs/path/.pi/agents/direct-write.yml",
            composition: "single-spawn",
            staged: false,
          },
        },
      }),
      state,
    );
    assert.equal(state.childWrote.length, 1);
    assert.equal(state.childWrote[0].name, "direct-write");
    assert.equal(
      state.childWrote[0].path,
      "/abs/path/.pi/agents/direct-write.yml",
    );
    assert.equal(state.staged.length, 0);
  });

  it("ignores unrelated events and non-end events", () => {
    const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
    EMIT_AGENT_SPEC.harvest({ type: "message_end" } as NDJSONEvent, state);
    EMIT_AGENT_SPEC.harvest(
      toolEnd({
        toolName: "emit_summary",
        result: { details: { staged: true, yaml: "x" } },
      }),
      state,
    );
    EMIT_AGENT_SPEC.harvest(
      {
        type: "tool_execution_start",
        toolName: "emit_agent_spec",
        args: { name: "won't-harvest" },
      } as NDJSONEvent,
      state,
    );
    assert.equal(state.staged.length, 0);
    assert.equal(state.childWrote.length, 0);
  });

  it("rejects malformed staged details (non-string fields)", () => {
    const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
    EMIT_AGENT_SPEC.harvest(
      toolEnd({
        toolName: "emit_agent_spec",
        result: {
          details: { name: 42, slash: "ok", staged: true, yaml: "x" },
        },
      }),
      state,
    );
    assert.equal(state.staged.length, 0);
  });
});

describe("emit-agent-spec parentSide finalize", () => {
  it("returns early with childWrote in written[] when no staged calls", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emit-spec-fz-"));
    try {
      const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
      state.childWrote.push({
        name: "already",
        path: path.join(root, ".pi", "agents", "already.yml"),
      });
      const fc = makeFctx(root);
      const result = (await EMIT_AGENT_SPEC.finalize(
        state,
        fc,
      )) as EmitAgentSpecResult;

      assert.equal(result.written.length, 1);
      assert.equal(result.written[0].name, "already");
      assert.equal(result.denied.length, 0);
      assert.equal(result.errors.length, 0);
      assert.equal(fc.confirmCalls.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("approves all staged when fctx.ctx.ui.confirm returns true; files land", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emit-spec-fz-"));
    try {
      const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
      state.staged.push({
        name: "alpha",
        slash: "alpha",
        composition: "single-spawn",
        yaml: "name: alpha\n",
      });
      state.staged.push({
        name: "beta",
        slash: "beta",
        composition: "single-spawn",
        yaml: "name: beta\n",
      });
      const fc = makeFctx(root, { confirmAnswers: [true, true] });
      const result = (await EMIT_AGENT_SPEC.finalize(
        state,
        fc,
      )) as EmitAgentSpecResult;

      assert.equal(result.written.length, 2);
      assert.equal(result.denied.length, 0);
      assert.equal(result.errors.length, 0);
      assert.equal(fc.confirmCalls.length, 2);
      assert.equal(
        fs.readFileSync(
          path.join(root, ".pi", "agents", "alpha.yml"),
          "utf8",
        ),
        "name: alpha\n",
      );
      assert.equal(
        fs.readFileSync(
          path.join(root, ".pi", "agents", "beta.yml"),
          "utf8",
        ),
        "name: beta\n",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies one spec independently of others; siblings still write", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emit-spec-fz-"));
    try {
      const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
      state.staged.push({
        name: "yes",
        slash: "yes",
        composition: "single-spawn",
        yaml: "name: yes\n",
      });
      state.staged.push({
        name: "no",
        slash: "no",
        composition: "single-spawn",
        yaml: "name: no\n",
      });
      const fc = makeFctx(root, { confirmAnswers: [true, false] });
      const result = (await EMIT_AGENT_SPEC.finalize(
        state,
        fc,
      )) as EmitAgentSpecResult;

      assert.equal(result.written.length, 1);
      assert.equal(result.written[0].name, "yes");
      assert.equal(result.denied.length, 1);
      assert.equal(result.denied[0].name, "no");
      assert.equal(result.denied[0].reason, "denied");
      assert.equal(
        fs.existsSync(path.join(root, ".pi", "agents", "no.yml")),
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels everything with reason=no-ui when fctx.ctx.hasUI=false", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emit-spec-fz-"));
    try {
      const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
      state.staged.push({
        name: "a",
        slash: "a",
        composition: "single-spawn",
        yaml: "name: a\n",
      });
      state.staged.push({
        name: "b",
        slash: "b",
        composition: "single-spawn",
        yaml: "name: b\n",
      });
      const fc = makeFctx(root, { hasUI: false });
      const result = (await EMIT_AGENT_SPEC.finalize(
        state,
        fc,
      )) as EmitAgentSpecResult;

      assert.equal(result.written.length, 0);
      assert.equal(result.denied.length, 2);
      assert.equal(result.denied[0].reason, "no-ui");
      assert.equal(result.denied[1].reason, "no-ui");
      assert.equal(
        fs.existsSync(path.join(root, ".pi", "agents", "a.yml")),
        false,
      );
      assert.equal(fc.notifyCalls.length, 1);
      assert.match(
        fc.notifyCalls[0].message,
        /staged but no UI to confirm/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels with reason=no-ui when ctx.ui.confirm is missing (older extension contexts)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emit-spec-fz-"));
    try {
      const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
      state.staged.push({
        name: "z",
        slash: "z",
        composition: "single-spawn",
        yaml: "name: z\n",
      });
      const fc = makeFctx(root, { hasUI: true, omitConfirm: true });
      const result = (await EMIT_AGENT_SPEC.finalize(
        state,
        fc,
      )) as EmitAgentSpecResult;

      assert.equal(result.denied.length, 1);
      assert.equal(result.denied[0].reason, "no-ui");
      assert.equal(
        fs.existsSync(path.join(root, ".pi", "agents", "z.yml")),
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-validates fs-state at finalize: stale duplicate file lands in errors[]", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emit-spec-fz-"));
    try {
      // Pre-create the destination — simulate a sibling write between
      // child stage-time and parent finalize-time.
      fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".pi", "agents", "race.yml"),
        "pre-existing\n",
        "utf8",
      );

      const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
      state.staged.push({
        name: "race",
        slash: "race",
        composition: "single-spawn",
        yaml: "name: race\n",
      });
      const fc = makeFctx(root);
      const result = (await EMIT_AGENT_SPEC.finalize(
        state,
        fc,
      )) as EmitAgentSpecResult;

      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].name, "race");
      assert.equal(result.errors[0].reason, "already exists");
      assert.equal(result.written.length, 0);
      // Confirm is NOT called for a spec that fails fs-state re-validation.
      assert.equal(fc.confirmCalls.length, 0);
      // Pre-existing file untouched.
      assert.equal(
        fs.readFileSync(
          path.join(root, ".pi", "agents", "race.yml"),
          "utf8",
        ),
        "pre-existing\n",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("integrates with execute(): direct-mode child write flows into childWrote → result.written", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emit-spec-fz-"));
    try {
      const tool = loadTool(root);
      const ctx = makeExecCtx();
      const childResult = await tool.execute(
        "ci",
        {
          name: "integration",
          slash: "integration",
          description: "x",
          composition: "single-spawn",
          phases: [{ components: ["cwd-guard"], prompt: "p" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
      EMIT_AGENT_SPEC.harvest(
        toolEnd({
          toolName: "emit_agent_spec",
          result: { details: childResult.details },
        }),
        state,
      );
      const fc = makeFctx(root);
      const result = (await EMIT_AGENT_SPEC.finalize(
        state,
        fc,
      )) as EmitAgentSpecResult;

      assert.equal(result.written.length, 1);
      assert.equal(result.written[0].name, "integration");
      // Parent didn't gate (child already wrote).
      assert.equal(fc.confirmCalls.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
