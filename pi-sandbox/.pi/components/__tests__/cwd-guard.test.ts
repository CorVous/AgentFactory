// cwd-guard.test.ts — tests for the cwd-policy component after the
// policy/surface split. Covers:
//   - default-export: PI_SANDBOX_ROOT contract, registers no tools,
//     attaches a `pi.on("tool_call")` auditor.
//   - validate(p, root): lex + realpath path validation.
//   - cwdGuardSide singleton: empty tools, sets PI_SANDBOX_ROOT,
//     correct spawnArgs.
//
// The sandbox_* tool-registration + per-verb path-validation tests
// migrated to sandbox-fs.test.ts.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CWD_GUARD_PATH,
  cwdGuardSide,
  validate,
} from "../cwd-guard.ts";
import cwdGuardLoader from "../cwd-guard.ts";

interface RegisteredTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

type ToolCallHandler = (event: {
  toolName: string;
  input: unknown;
}) => unknown;

function makeStubPi() {
  const tools: RegisteredTool[] = [];
  let toolCallHandler: ToolCallHandler | undefined;
  return {
    pi: {
      registerTool: (def: RegisteredTool) => tools.push(def),
      on: (channel: string, h: ToolCallHandler) => {
        if (channel === "tool_call") toolCallHandler = h;
      },
    } as unknown as Parameters<typeof cwdGuardLoader>[0],
    tools,
    callAuditor(toolName: string, input: unknown) {
      if (!toolCallHandler) {
        throw new Error("auditor not registered");
      }
      return toolCallHandler({ toolName, input });
    },
    hasAuditor: () => toolCallHandler !== undefined,
  };
}

function withEnv<T>(
  vars: Record<string, string | undefined>,
  body: () => T,
): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeTempRoot(): string {
  // realpath the result so /private/var vs /var symlink resolution on
  // macOS doesn't trip the validate() lex check.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cwd-guard-test-")));
}

/* ---------- default-export contract ----------------------------------- */

describe("cwd-guard: default export", () => {
  it("throws when PI_SANDBOX_ROOT is missing", () => {
    const { pi } = makeStubPi();
    assert.throws(
      () =>
        withEnv({ PI_SANDBOX_ROOT: undefined }, () => cwdGuardLoader(pi)),
      /PI_SANDBOX_ROOT must be set/,
    );
  });

  it("registers zero tools", () => {
    const root = makeTempRoot();
    const { pi, tools } = makeStubPi();
    withEnv({ PI_SANDBOX_ROOT: root }, () => cwdGuardLoader(pi));
    assert.equal(tools.length, 0);
  });

  it("attaches a tool_call auditor", () => {
    const root = makeTempRoot();
    const { pi, hasAuditor } = makeStubPi();
    withEnv({ PI_SANDBOX_ROOT: root }, () => cwdGuardLoader(pi));
    assert.equal(hasAuditor(), true);
  });
});

/* ---------- tool_call auditor ---------------------------------------- */

describe("cwd-guard: tool_call auditor", () => {
  it("blocks tool_call with absolute out-of-cwd path arg", () => {
    const root = makeTempRoot();
    const stub = makeStubPi();
    withEnv({ PI_SANDBOX_ROOT: root }, () => cwdGuardLoader(stub.pi));
    const result = stub.callAuditor("sandbox_read", { path: "/etc/passwd" }) as {
      block?: boolean;
      reason?: string;
    };
    assert.equal(result.block, true);
    assert.match(String(result.reason ?? ""), /escapes sandbox root/);
  });

  it("blocks recursive nested out-of-cwd path arg", () => {
    const root = makeTempRoot();
    const stub = makeStubPi();
    withEnv({ PI_SANDBOX_ROOT: root }, () => cwdGuardLoader(stub.pi));
    const result = stub.callAuditor("sandbox_grep", {
      pattern: "x",
      nested: { paths: ["/etc/passwd"] },
    }) as { block?: boolean };
    assert.equal(result.block, true);
  });

  it("allows in-bounds absolute path arg", () => {
    const root = makeTempRoot();
    const stub = makeStubPi();
    withEnv({ PI_SANDBOX_ROOT: root }, () => cwdGuardLoader(stub.pi));
    const result = stub.callAuditor("sandbox_read", {
      path: path.join(root, "x.txt"),
    }) as { block?: boolean };
    assert.notEqual(result.block, true);
  });

  it("allows relative paths (auditor only checks absolute)", () => {
    const root = makeTempRoot();
    const stub = makeStubPi();
    withEnv({ PI_SANDBOX_ROOT: root }, () => cwdGuardLoader(stub.pi));
    const result = stub.callAuditor("sandbox_read", {
      path: "subdir/file.txt",
    }) as { block?: boolean };
    assert.notEqual(result.block, true);
  });

  it("blocks tool with a name not matching the allowed-prefix set", () => {
    const root = makeTempRoot();
    const stub = makeStubPi();
    withEnv({ PI_SANDBOX_ROOT: root }, () => cwdGuardLoader(stub.pi));
    const result = stub.callAuditor("exec_shell", {}) as {
      block?: boolean;
      reason?: string;
    };
    assert.equal(result.block, true);
    assert.match(String(result.reason ?? ""), /unexpected tool name/);
  });

  it("allows tools whose names match the allowlisted prefixes", () => {
    const root = makeTempRoot();
    const stub = makeStubPi();
    withEnv({ PI_SANDBOX_ROOT: root }, () => cwdGuardLoader(stub.pi));
    for (const name of [
      "sandbox_ls",
      "stage_write",
      "emit_summary",
      "run_deferred_writer",
      "review",
    ]) {
      const result = stub.callAuditor(name, {}) as { block?: boolean };
      assert.notEqual(result.block, true, `${name} should not be blocked`);
    }
  });
});

/* ---------- exported validate() --------------------------------------- */

describe("cwd-guard: validate()", () => {
  it("rejects absolute path outside root", () => {
    const root = makeTempRoot();
    assert.throws(() => validate("/etc/passwd", root), /escapes sandbox root/);
  });

  it("accepts path inside root", () => {
    const root = makeTempRoot();
    const ok = validate(path.join(root, "sub", "file.txt"), root);
    assert.equal(ok, path.resolve(path.join(root, "sub", "file.txt")));
  });

  it("rejects symlink that escapes root", () => {
    const root = makeTempRoot();
    const escapeTarget = makeTempRoot(); // a separate dir
    const linkAbs = path.join(root, "trap");
    fs.symlinkSync(escapeTarget, linkAbs);
    assert.throws(
      () => validate(path.join(linkAbs, "stolen.txt"), root),
      /escapes sandbox root via symlink/,
    );
  });
});

/* ---------- cwdGuardSide singleton ------------------------------------ */

describe("cwd-guard: cwdGuardSide parentSide", () => {
  it("declares zero tools", () => {
    assert.deepEqual([...cwdGuardSide.tools], []);
  });

  it("name is 'cwd-guard'", () => {
    assert.equal(cwdGuardSide.name, "cwd-guard");
  });

  it("env({cwd}) sets PI_SANDBOX_ROOT only (no PI_SANDBOX_VERBS)", () => {
    const env = cwdGuardSide.env({ cwd: "/some/cwd" });
    assert.equal(env.PI_SANDBOX_ROOT, "/some/cwd");
    assert.equal(env.PI_SANDBOX_VERBS, undefined);
  });

  it("spawnArgs is `['-e', <CWD_GUARD_PATH>]`", () => {
    assert.deepEqual([...cwdGuardSide.spawnArgs], ["-e", CWD_GUARD_PATH]);
    assert.match(CWD_GUARD_PATH, /cwd-guard\.ts$/);
  });

  it("harvest is a no-op and finalize returns {}", () => {
    const state = cwdGuardSide.initialState();
    cwdGuardSide.harvest({} as Record<string, unknown>, state);
    const result = cwdGuardSide.finalize(state, {} as never);
    assert.deepEqual(result, {});
  });
});
