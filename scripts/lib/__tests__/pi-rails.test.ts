// pi-rails.test.ts — node:test cases for the rails contract helper.
// Mirrors the FORBIDDEN_TOOLS list in
// pi-sandbox/.pi/lib/delegate.ts:48-51 and the ALL_VERBS list in
// pi-sandbox/.pi/components/cwd-guard.ts. If either of those
// changes, this file should fail and force the contract update.

import { strict as assert } from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  FORBIDDEN_BUILTIN_VERBS,
  SANDBOX_VERBS,
  assertRailsCompatibleTools,
  parseToolsCsv,
  piRailsEnv,
  piRailsExtensionArgs,
} from "../pi-rails.ts";

describe("FORBIDDEN_BUILTIN_VERBS", () => {
  it("matches delegate.ts FORBIDDEN_TOOLS", () => {
    // delegate.ts:48-51 — `read|ls|grep|glob|write|edit|bash`.
    assert.deepEqual(
      [...FORBIDDEN_BUILTIN_VERBS].sort(),
      ["bash", "edit", "glob", "grep", "ls", "read", "write"],
    );
  });
});

describe("SANDBOX_VERBS", () => {
  it("matches cwd-guard.ts ALL_VERBS", () => {
    assert.deepEqual(
      [...SANDBOX_VERBS].sort(),
      [
        "sandbox_edit",
        "sandbox_glob",
        "sandbox_grep",
        "sandbox_ls",
        "sandbox_read",
        "sandbox_write",
      ],
    );
  });
});

describe("parseToolsCsv", () => {
  it("trims tokens and drops empties", () => {
    const r = parseToolsCsv(" sandbox_read , , emit_agent_spec  ");
    assert.deepEqual(r.tokens, ["sandbox_read", "emit_agent_spec"]);
  });

  it("classifies sandbox verbs and forbidden verbs", () => {
    const r = parseToolsCsv("sandbox_read,read,emit_agent_spec,bash");
    assert.deepEqual(r.sandboxVerbs.sort(), ["sandbox_read"]);
    assert.deepEqual(r.forbidden.sort(), ["bash", "read"]);
    assert.deepEqual(
      r.tokens.sort(),
      ["bash", "emit_agent_spec", "read", "sandbox_read"],
    );
  });

  it("handles empty input", () => {
    const r = parseToolsCsv("");
    assert.deepEqual(r.tokens, []);
    assert.deepEqual(r.sandboxVerbs, []);
    assert.deepEqual(r.forbidden, []);
  });
});

describe("assertRailsCompatibleTools", () => {
  it("accepts a sandbox-only tools list", () => {
    assert.doesNotThrow(() =>
      assertRailsCompatibleTools(
        "sandbox_read,sandbox_ls,sandbox_grep,emit_agent_spec",
      ),
    );
  });

  it("accepts a custom-stub tools list with no fs verbs at all", () => {
    assert.doesNotThrow(() =>
      assertRailsCompatibleTools("emit_agent_spec,stage_write"),
    );
  });

  for (const verb of ["read", "ls", "grep", "glob", "write", "edit", "bash"]) {
    it(`rejects --tools that includes built-in '${verb}'`, () => {
      assert.throws(
        () => assertRailsCompatibleTools(`${verb},emit_agent_spec`),
        new RegExp(`forbidden built-in verb.*${verb}`),
      );
    });
  }

  it("names every forbidden verb in the error when multiple appear", () => {
    assert.throws(
      () => assertRailsCompatibleTools("read,bash,sandbox_read"),
      (err: unknown) => {
        const msg = (err as Error).message;
        return /read/.test(msg) && /bash/.test(msg);
      },
    );
  });

  it("suggests the sandbox_* replacement in the error", () => {
    assert.throws(
      () => assertRailsCompatibleTools("read,emit_agent_spec"),
      /sandbox_read/,
    );
  });
});

describe("piRailsExtensionArgs", () => {
  const sandbox = "/tmp/sandbox";
  const cwdGuardPath = path.join(sandbox, ".pi", "components", "cwd-guard.ts");
  const sandboxFsPath = path.join(sandbox, ".pi", "components", "sandbox-fs.ts");

  it("always includes cwd-guard", () => {
    const args = piRailsExtensionArgs(sandbox, "emit_agent_spec");
    assert.deepEqual(args, ["-e", cwdGuardPath]);
  });

  it("includes sandbox-fs when at least one sandbox_* verb is in tools", () => {
    const args = piRailsExtensionArgs(
      sandbox,
      "sandbox_read,emit_agent_spec",
    );
    assert.deepEqual(args, [
      "-e",
      cwdGuardPath,
      "-e",
      sandboxFsPath,
    ]);
  });

  it("does NOT include sandbox-fs when no sandbox_* verb is in tools", () => {
    const args = piRailsExtensionArgs(sandbox, "emit_agent_spec,stage_write");
    assert.deepEqual(args, ["-e", cwdGuardPath]);
  });
});

describe("piRailsEnv", () => {
  const sandbox = "/tmp/sandbox";

  it("always sets PI_SANDBOX_ROOT", () => {
    const env = piRailsEnv(sandbox, "emit_agent_spec");
    assert.equal(env.PI_SANDBOX_ROOT, sandbox);
  });

  it("sets PI_SANDBOX_VERBS to the sandbox subset only", () => {
    const env = piRailsEnv(
      sandbox,
      "sandbox_read,sandbox_ls,emit_agent_spec",
    );
    assert.equal(env.PI_SANDBOX_ROOT, sandbox);
    assert.equal(env.PI_SANDBOX_VERBS, "sandbox_read,sandbox_ls");
  });

  it("omits PI_SANDBOX_VERBS when no sandbox_* verb is requested", () => {
    const env = piRailsEnv(sandbox, "emit_agent_spec,stage_write");
    assert.equal(env.PI_SANDBOX_ROOT, sandbox);
    assert.equal(env.PI_SANDBOX_VERBS, undefined);
  });
});
