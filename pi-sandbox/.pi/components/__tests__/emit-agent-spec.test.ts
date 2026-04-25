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

function toolStart(toolName: string, args: Record<string, unknown>): NDJSONEvent {
  return { type: "tool_execution_start", toolName, args };
}

function fctx(sandboxRoot: string): FinalizeContext {
  return {
    ctx: { ui: { notify: () => {} } },
    sandboxRoot,
  };
}

interface CapturedTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
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
      ["sequential-phases-with-brief", "single-spawn"],
    );
  });
});

/* ---------- tool execute() — happy path & guards --------------------- */

describe("emit_agent_spec tool execute()", () => {
  it("writes a YAML file under <root>/.pi/agents/<name>.yml that round-trips", async () => {
    const tool = loadTool(SANDBOX);
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
    const result = await tool.execute("call-1", params);

    const dest = path.join(SANDBOX, ".pi", "agents", "demo-agent.yml");
    assert.ok(fs.existsSync(dest), "expected YAML file on disk");
    assert.equal(result.details.name, "demo-agent");
    assert.equal(result.details.path, dest);
    assert.equal(result.details.composition, "single-spawn");
    assert.match(result.content[0].text, /Wrote spec/);

    const reloaded = yamlParse(fs.readFileSync(dest, "utf8"));
    assert.deepEqual(reloaded, params);
  });

  it("path-escape guard rejects names that would resolve outside agents dir", async () => {
    const tool = loadTool(SANDBOX);
    // The factory's name regex actually rejects `..` first via NAME_RE,
    // but we still want to prove no file lands outside the agents dir.
    await assert.rejects(
      tool.execute("call-2", {
        name: "../escape",
        slash: "ok",
        description: "x",
        composition: "single-spawn",
        phases: [{ components: ["cwd-guard"], prompt: "p" }],
      }),
      /name must match|path escapes/,
    );
    const escapeAt = path.join(SANDBOX, ".pi", "escape.yml");
    assert.equal(fs.existsSync(escapeAt), false);
  });

  it("duplicate-file guard refuses to overwrite an existing spec", async () => {
    const tool = loadTool(SANDBOX);
    const params = {
      name: "dup-agent",
      slash: "dup",
      description: "first emit",
      composition: "single-spawn",
      phases: [{ components: ["cwd-guard"], prompt: "first" }],
    };
    await tool.execute("c1", params);
    const dest = path.join(SANDBOX, ".pi", "agents", "dup-agent.yml");
    const firstYaml = fs.readFileSync(dest, "utf8");

    await assert.rejects(
      tool.execute("c2", { ...params, description: "second emit" }),
      /already exists/,
    );
    // Original content untouched.
    assert.equal(fs.readFileSync(dest, "utf8"), firstYaml);
  });

  it("name regex enforced through tool execute (catches stale params)", async () => {
    const tool = loadTool(SANDBOX);
    await assert.rejects(
      tool.execute("c3", {
        name: "BAD_NAME",
        slash: "ok",
        description: "x",
        composition: "single-spawn",
        phases: [{ components: ["cwd-guard"], prompt: "p" }],
      }),
      /name must match/,
    );
  });

  it("phase rules enforced through tool execute (composer cannot bypass)", async () => {
    const tool = loadTool(SANDBOX);
    await assert.rejects(
      tool.execute("c4", {
        name: "phase-bad",
        slash: "phase",
        description: "x",
        composition: "sequential-phases-with-brief",
        phases: [
          { components: ["cwd-guard"], prompt: "scout" }, // missing emit-summary
          { components: ["stage-write"], prompt: "draft" },
        ],
      }),
      /phase 1 must include `emit-summary`/,
    );
    assert.equal(
      fs.existsSync(path.join(SANDBOX, ".pi", "agents", "phase-bad.yml")),
      false,
    );
  });
});

/* ---------- parentSide harvest + finalize ---------------------------- */

describe("emit-agent-spec parentSide", () => {
  it("records the spec name on a successful emit_agent_spec call and verifies the file exists at finalize", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emit-spec-ps-"));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emit-spec-ps-"));
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

  it("ignores unrelated events, non-string args.name, and pre-tool message_end events", async () => {
    const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
    EMIT_AGENT_SPEC.harvest({ type: "message_end" } as NDJSONEvent, state);
    EMIT_AGENT_SPEC.harvest(
      toolStart("emit_summary", { title: "t", body: "b" }),
      state,
    );
    EMIT_AGENT_SPEC.harvest(
      toolStart("emit_agent_spec", { name: 42 }),
      state,
    );
    assert.equal(state.wrote, true); // tool fired
    assert.equal(state.name, undefined); // but name was not a string

    const result = (await EMIT_AGENT_SPEC.finalize(
      state,
      fctx(SANDBOX),
    )) as EmitAgentSpecResult;
    assert.equal(result.wrote, false);
    assert.equal(result.name, undefined);
  });

  it("integrates with execute(): tool-write + parentSide harvest yield wrote=true", async () => {
    // Drives the real tool execute, then runs harvest+finalize over a
    // matching synthetic event so the on-disk file produced by execute()
    // is what finalize verifies.
    const tool = loadTool(SANDBOX);
    await tool.execute("ci", {
      name: "integration",
      slash: "integration",
      description: "x",
      composition: "single-spawn",
      phases: [{ components: ["cwd-guard"], prompt: "p" }],
    });

    const state: EmitAgentSpecState = EMIT_AGENT_SPEC.initialState();
    EMIT_AGENT_SPEC.harvest(
      toolStart("emit_agent_spec", { name: "integration", slash: "integration" }),
      state,
    );
    const result = (await EMIT_AGENT_SPEC.finalize(
      state,
      fctx(SANDBOX),
    )) as EmitAgentSpecResult;
    assert.equal(result.wrote, true);
    assert.equal(result.name, "integration");
  });
});
