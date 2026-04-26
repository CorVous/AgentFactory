// yaml-agent-runner.test.ts — pins the pure helpers in
// yaml-agent-runner.ts (substitute, validateSpec, buildBrief,
// MAX_BRIEF_BYTES). The handler itself spawns child pi processes so
// it isn't unit-tested here; the validators and template logic are
// what actually gate which YAML specs become slash commands.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  buildBrief,
  MAX_BRIEF_BYTES,
  substitute,
  validateSpec,
  type AgentSpec,
} from "../yaml-agent-runner.ts";

/* ---------- substitute ----------------------------------------------- */

describe("substitute", () => {
  it("replaces every recognized template variable", () => {
    const out = substitute("a={args} r={sandboxRoot} b={brief}", {
      args: "X",
      sandboxRoot: "/tmp/sandbox",
      brief: "## title\nbody",
    });
    assert.equal(out, "a=X r=/tmp/sandbox b=## title\nbody");
  });

  it("substitutes repeated occurrences of the same variable", () => {
    const out = substitute("{args}-{args}-{args}", { args: "Q" });
    assert.equal(out, "Q-Q-Q");
  });

  it("leaves unmapped variables untouched (no var in the dict)", () => {
    const out = substitute("hello {args} {missing}", { args: "world" });
    // {missing} is not one of the recognized keys, so the regex never
    // matches it; even if it did, vars[missing] would be undefined and
    // the replacer returns the original match.
    assert.equal(out, "hello world {missing}");
  });

  it("leaves the placeholder when a recognized key is undefined in vars", () => {
    const out = substitute("a={args} b={brief}", { args: "X" });
    assert.equal(out, "a=X b={brief}");
  });

  it("leaves text without any placeholders unchanged", () => {
    assert.equal(substitute("plain text", { args: "X" }), "plain text");
  });

  it("does not touch unknown placeholder names", () => {
    // Only args / sandboxRoot / brief are recognized; everything else
    // passes through verbatim. This protects user prompts that
    // legitimately contain `{...}` syntax (e.g. JSON examples).
    assert.equal(
      substitute('json: {"key": "value"} brief={brief}', { brief: "B" }),
      'json: {"key": "value"} brief=B',
    );
  });
});

/* ---------- buildBrief ----------------------------------------------- */

describe("buildBrief", () => {
  it("formats summaries as `## title\\nbody`, joined by blank line", () => {
    const out = buildBrief([
      { title: "Skills", body: "lists every skill" },
      { title: "Components", body: "five canonical parts" },
    ]);
    assert.equal(
      out,
      "## Skills\nlists every skill\n\n## Components\nfive canonical parts",
    );
  });

  it("returns empty string for an empty summary list", () => {
    assert.equal(buildBrief([]), "");
  });

  it("preserves multi-line bodies verbatim", () => {
    const out = buildBrief([{ title: "T", body: "line 1\nline 2\nline 3" }]);
    assert.equal(out, "## T\nline 1\nline 2\nline 3");
  });

  it("MAX_BRIEF_BYTES is the documented 16 KB cap", () => {
    // Pin the constant — handler relies on it; tests downstream of this
    // refactor will too.
    assert.equal(MAX_BRIEF_BYTES, 16_000);
  });

  it("can produce a brief that exceeds MAX_BRIEF_BYTES (handler enforces cap)", () => {
    // buildBrief itself is a pure formatter; the handler is what aborts.
    // This test just documents the contract: the helper does not
    // truncate, so callers MUST byte-check before substituting.
    const big = "x".repeat(MAX_BRIEF_BYTES + 100);
    const out = buildBrief([{ title: "huge", body: big }]);
    assert.ok(Buffer.byteLength(out, "utf8") > MAX_BRIEF_BYTES);
  });
});

/* ---------- validateSpec --------------------------------------------- */

// Fixtures: cwd-guard and sandbox-fs are auto-injected by delegate(),
// so user-listed `components` arrays must NOT include them. The runner
// rejects either name with an "auto-injected; do not list" error.
const VALID_SINGLE_SPAWN: Record<string, unknown> = {
  name: "demo",
  slash: "demo",
  description: "Tiny single-spawn agent.",
  composition: "single-spawn",
  phases: [
    {
      name: "draft",
      components: ["stage-write"],
      tools: ["sandbox_ls", "stage_write"],
      prompt: "Do {args}",
    },
  ],
};

const VALID_SEQUENTIAL: Record<string, unknown> = {
  name: "scout-then-draft",
  slash: "std",
  description: "Sequential scout-then-draft.",
  composition: "sequential-phases-with-brief",
  phases: [
    {
      name: "scout",
      components: ["emit-summary"],
      tools: ["sandbox_ls", "sandbox_read", "sandbox_grep", "sandbox_glob", "emit_summary"],
      prompt: "scout {args}",
    },
    {
      name: "draft",
      components: ["stage-write"],
      tools: ["sandbox_ls", "stage_write"],
      prompt: "draft using {brief}",
    },
  ],
};

const VALID_DISPATCHER: Record<string, unknown> = {
  name: "drafter-fanout",
  slash: "drafter-fanout",
  description: "Dispatcher that fans out to several drafters.",
  composition: "single-spawn-with-dispatch",
  phases: [
    {
      name: "orchestrate",
      components: ["dispatch-agent"],
      tools: ["dispatch_agent"],
      prompt:
        "Task: {args}. Decompose into 1-3 drafters and dispatch_agent each.",
    },
  ],
};

describe("validateSpec — happy paths", () => {
  it("accepts a valid single-spawn spec", () => {
    const spec = validateSpec(VALID_SINGLE_SPAWN, "demo.yml");
    assert.equal(spec.name, "demo");
    assert.equal(spec.composition, "single-spawn");
    assert.equal(spec.phases.length, 1);
  });

  it("accepts a valid sequential-phases-with-brief spec", () => {
    const spec: AgentSpec = validateSpec(VALID_SEQUENTIAL, "std.yml");
    assert.equal(spec.composition, "sequential-phases-with-brief");
    assert.equal(spec.phases.length, 2);
    assert.deepEqual(spec.phases[0].components, ["emit-summary"]);
    assert.deepEqual(spec.phases[1].components, ["stage-write"]);
  });

  it("accepts a valid single-spawn-with-dispatch spec", () => {
    const spec: AgentSpec = validateSpec(
      VALID_DISPATCHER,
      "drafter-fanout.yml",
    );
    assert.equal(spec.composition, "single-spawn-with-dispatch");
    assert.equal(spec.phases.length, 1);
    assert.deepEqual(spec.phases[0].components, ["dispatch-agent"]);
    assert.deepEqual(spec.phases[0].tools, ["dispatch_agent"]);
  });
});

describe("validateSpec — single-spawn-with-dispatch rules", () => {
  it("rejects when phase is missing dispatch-agent in components", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_DISPATCHER,
            phases: [
              {
                components: ["stage-write"],
                tools: ["dispatch_agent", "stage_write"],
                prompt: "p",
              },
            ],
          },
          "x.yml",
        ),
      /must include "dispatch-agent" in components/,
    );
  });

  it("rejects when phase is missing dispatch_agent in tools", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_DISPATCHER,
            phases: [
              {
                components: ["dispatch-agent"],
                tools: ["sandbox_ls"],
                prompt: "p",
              },
            ],
          },
          "x.yml",
        ),
      /tools is missing tools required|must include "dispatch_agent" in tools/,
    );
  });

  it("rejects when phase has no tools field at all", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_DISPATCHER,
            phases: [
              {
                components: ["dispatch-agent"],
                prompt: "p",
              },
            ],
          },
          "x.yml",
        ),
      /must include "dispatch_agent" in tools/,
    );
  });

  it("rejects more than one phase", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_DISPATCHER,
            phases: [
              {
                components: ["dispatch-agent"],
                tools: ["dispatch_agent"],
                prompt: "a",
              },
              {
                components: ["dispatch-agent"],
                tools: ["dispatch_agent"],
                prompt: "b",
              },
            ],
          },
          "x.yml",
        ),
      /single-spawn-with-dispatch requires exactly 1 phase/,
    );
  });
});

describe("validateSpec — top-level shape", () => {
  it("rejects non-object input", () => {
    assert.throws(() => validateSpec("not an object", "x.yml"), /not an object/);
    assert.throws(() => validateSpec(null, "x.yml"), /not an object/);
    assert.throws(() => validateSpec(42, "x.yml"), /not an object/);
  });

  it("rejects missing top-level keys", () => {
    for (const missing of ["name", "slash", "description", "composition"]) {
      const obj = { ...VALID_SINGLE_SPAWN };
      delete (obj as Record<string, unknown>)[missing];
      assert.throws(
        () => validateSpec(obj, "x.yml"),
        new RegExp(`missing or non-string "${missing}"`),
      );
    }
  });

  it("rejects unknown composition", () => {
    assert.throws(
      () =>
        validateSpec({ ...VALID_SINGLE_SPAWN, composition: "rpc-delegator-over-concurrent-drafters" }, "x.yml"),
      /not runnable here/,
    );
  });

  it("rejects phases that are not a non-empty array", () => {
    assert.throws(
      () => validateSpec({ ...VALID_SINGLE_SPAWN, phases: [] }, "x.yml"),
      /phases must be a non-empty array/,
    );
    assert.throws(
      () => validateSpec({ ...VALID_SINGLE_SPAWN, phases: "not array" }, "x.yml"),
      /phases must be a non-empty array/,
    );
  });
});

describe("validateSpec — composition / phase rules", () => {
  it("rejects single-spawn with the wrong phase count", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_SINGLE_SPAWN,
            phases: [
              { components: ["stage-write"], tools: ["stage_write"], prompt: "a" },
              { components: ["stage-write"], tools: ["stage_write"], prompt: "b" },
            ],
          },
          "x.yml",
        ),
      /single-spawn requires exactly 1 phase, got 2/,
    );
  });

  it("rejects sequential-phases-with-brief with the wrong phase count", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_SEQUENTIAL,
            phases: [{ components: ["emit-summary"], prompt: "p" }],
          },
          "x.yml",
        ),
      /sequential-phases-with-brief requires exactly 2 phases, got 1/,
    );
  });
});

describe("validateSpec — phase shape", () => {
  it("rejects unknown component names with a list of known components", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_SINGLE_SPAWN,
            phases: [
              { components: ["bogus-component"], prompt: "p" },
            ],
          },
          "x.yml",
        ),
      /unknown component "bogus-component"/,
    );
  });

  it("rejects review and run-deferred-writer (RPC topology)", () => {
    for (const c of ["review", "run-deferred-writer"]) {
      assert.throws(
        () =>
          validateSpec(
            {
              ...VALID_SINGLE_SPAWN,
              phases: [{ components: [c], prompt: "p" }],
            },
            "x.yml",
          ),
        /RPC-delegator topology|pi-agent-builder/,
      );
    }
  });

  it("rejects empty components array", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_SINGLE_SPAWN,
            phases: [{ components: [], prompt: "p" }],
          },
          "x.yml",
        ),
      /components must be non-empty/,
    );
  });

  it("rejects non-string prompt", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_SINGLE_SPAWN,
            phases: [{ components: ["stage-write"], prompt: 42 }],
          },
          "x.yml",
        ),
      /prompt must be a non-empty string/,
    );
  });

  it("rejects components listing 'cwd-guard' (auto-injected)", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_SINGLE_SPAWN,
            phases: [
              {
                components: ["cwd-guard", "stage-write"],
                tools: ["stage_write"],
                prompt: "p",
              },
            ],
          },
          "x.yml",
        ),
      /must not list "cwd-guard" — auto-injected/,
    );
  });

  it("rejects components listing 'sandbox-fs' (auto-injected)", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_SINGLE_SPAWN,
            phases: [
              {
                components: ["sandbox-fs", "stage-write"],
                tools: ["sandbox_ls", "stage_write"],
                prompt: "p",
              },
            ],
          },
          "x.yml",
        ),
      /must not list "sandbox-fs" — auto-injected/,
    );
  });
});

describe("validateSpec — explicit tools allowlist", () => {
  it("accepts a tools list that covers every component's declared tools", () => {
    const spec = validateSpec(
      {
        ...VALID_SINGLE_SPAWN,
        phases: [
          {
            components: ["stage-write"],
            tools: [
              "sandbox_read",
              "sandbox_ls",
              "sandbox_grep",
              "stage_write",
            ],
            prompt: "p",
          },
        ],
      },
      "x.yml",
    );
    assert.deepEqual(spec.phases[0].tools, [
      "sandbox_read",
      "sandbox_ls",
      "sandbox_grep",
      "stage_write",
    ]);
  });

  it("rejects a tools list missing a tool a declared component contributes", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_SINGLE_SPAWN,
            phases: [
              {
                components: ["stage-write"],
                // missing stage_write
                tools: ["sandbox_ls"],
                prompt: "p",
              },
            ],
          },
          "x.yml",
        ),
      /tools is missing tools required by declared components/,
    );
  });

  it("rejects a tools field that is not a non-empty string array", () => {
    assert.throws(
      () =>
        validateSpec(
          {
            ...VALID_SINGLE_SPAWN,
            phases: [{ components: ["stage-write"], tools: [], prompt: "p" }],
          },
          "x.yml",
        ),
      /tools must be a non-empty array of strings/,
    );
  });
});
