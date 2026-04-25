// sandbox-fs.test.ts — unit tests for the path-validated fs tool
// surface. Mirrors what cwd-guard.test.ts covered before the
// policy/surface split: env-gated tool registration via
// PI_SANDBOX_VERBS, per-verb path validation, and the
// makeSandboxFs() factory contract.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  makeSandboxFs,
  SANDBOX_FS_PATH,
} from "../sandbox-fs.ts";
import sandboxFsLoader from "../sandbox-fs.ts";
import type { SandboxVerb } from "../cwd-guard.ts";

interface RegisteredTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

function makeStubPi() {
  const tools: RegisteredTool[] = [];
  return {
    pi: {
      registerTool: (def: RegisteredTool) => tools.push(def),
      on: () => {
        /* sandbox-fs only registers tools; no event handlers */
      },
    } as unknown as Parameters<typeof sandboxFsLoader>[0],
    tools,
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
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-fs-test-")));
}

/* ---------- env-gated registration ------------------------------------ */

describe("sandbox-fs: env-gated registration", () => {
  it("throws when PI_SANDBOX_ROOT is missing", () => {
    const { pi } = makeStubPi();
    assert.throws(
      () =>
        withEnv(
          { PI_SANDBOX_ROOT: undefined, PI_SANDBOX_VERBS: "sandbox_ls" },
          () => sandboxFsLoader(pi),
        ),
      /PI_SANDBOX_ROOT must be set/,
    );
  });

  it("registers zero tools when PI_SANDBOX_VERBS is missing or empty", () => {
    const root = makeTempRoot();
    const { pi, tools } = makeStubPi();
    withEnv({ PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: undefined }, () =>
      sandboxFsLoader(pi),
    );
    assert.equal(tools.length, 0);
    const { pi: pi2, tools: tools2 } = makeStubPi();
    withEnv({ PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: "" }, () =>
      sandboxFsLoader(pi2),
    );
    assert.equal(tools2.length, 0);
  });

  it("rejects unknown verbs in PI_SANDBOX_VERBS", () => {
    const root = makeTempRoot();
    const { pi } = makeStubPi();
    assert.throws(
      () =>
        withEnv(
          { PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: "sandbox_telnet" },
          () => sandboxFsLoader(pi),
        ),
      /unknown verb/,
    );
  });

  it("registers only the verbs listed in PI_SANDBOX_VERBS", () => {
    const root = makeTempRoot();
    const { pi, tools } = makeStubPi();
    withEnv(
      { PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: "sandbox_ls,sandbox_read" },
      () => sandboxFsLoader(pi),
    );
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["sandbox_ls", "sandbox_read"]);
  });

  it("registers all six verbs when all are listed", () => {
    const root = makeTempRoot();
    const { pi, tools } = makeStubPi();
    withEnv(
      {
        PI_SANDBOX_ROOT: root,
        PI_SANDBOX_VERBS:
          "sandbox_read,sandbox_ls,sandbox_grep,sandbox_glob,sandbox_write,sandbox_edit",
      },
      () => sandboxFsLoader(pi),
    );
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "sandbox_edit",
      "sandbox_glob",
      "sandbox_grep",
      "sandbox_ls",
      "sandbox_read",
      "sandbox_write",
    ]);
  });
});

/* ---------- path validation through tool execute ---------------------- */

describe("sandbox-fs: path validation in tool bodies", () => {
  it("sandbox_write rejects absolute path outside root", async () => {
    const root = makeTempRoot();
    const { pi, tools } = makeStubPi();
    withEnv(
      { PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: "sandbox_write" },
      () => sandboxFsLoader(pi),
    );
    const sandboxWrite = tools.find((t) => t.name === "sandbox_write")!;
    await assert.rejects(
      () => sandboxWrite.execute("1", { path: "/etc/passwd", content: "x" }),
      /escapes sandbox root/,
    );
  });

  it("sandbox_write rejects '..' that escapes root", async () => {
    const root = makeTempRoot();
    const { pi, tools } = makeStubPi();
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      withEnv(
        { PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: "sandbox_write" },
        () => sandboxFsLoader(pi),
      );
      const sandboxWrite = tools.find((t) => t.name === "sandbox_write")!;
      await assert.rejects(
        () =>
          sandboxWrite.execute("1", {
            path: "../escape.txt",
            content: "x",
          }),
        /escapes sandbox root/,
      );
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("sandbox_read succeeds inside root and returns the file content", async () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "hello.txt");
    fs.writeFileSync(filePath, "hi there", "utf8");
    const { pi, tools } = makeStubPi();
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      withEnv(
        { PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: "sandbox_read" },
        () => sandboxFsLoader(pi),
      );
      const sandboxRead = tools.find((t) => t.name === "sandbox_read")!;
      const result = (await sandboxRead.execute("1", { path: "hello.txt" })) as {
        content: { type: string; text: string }[];
      };
      assert.equal(result.content[0].text, "hi there");
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("sandbox_ls returns directory entries", async () => {
    const root = makeTempRoot();
    fs.writeFileSync(path.join(root, "a.txt"), "");
    fs.mkdirSync(path.join(root, "sub"));
    const { pi, tools } = makeStubPi();
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      withEnv(
        { PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: "sandbox_ls" },
        () => sandboxFsLoader(pi),
      );
      const sandboxLs = tools.find((t) => t.name === "sandbox_ls")!;
      const result = (await sandboxLs.execute("1", { path: "." })) as {
        details: { entries: { name: string; kind: string }[] };
      };
      const names = result.details.entries.map((e) => e.name).sort();
      assert.deepEqual(names, ["a.txt", "sub"]);
    } finally {
      process.chdir(prevCwd);
    }
  });
});

/* ---------- makeSandboxFs factory ------------------------------------- */

describe("makeSandboxFs factory", () => {
  it("throws on empty verb list", () => {
    assert.throws(
      () => makeSandboxFs({ verbs: [] as ReadonlyArray<SandboxVerb> }),
      /must be non-empty/,
    );
  });

  it("throws on unknown verb", () => {
    assert.throws(
      () =>
        makeSandboxFs({ verbs: ["bogus_verb"] as unknown as SandboxVerb[] }),
      /unknown verb/,
    );
  });

  it("parentSide.tools matches the requested verb subset", () => {
    const ps = makeSandboxFs({ verbs: ["sandbox_read", "sandbox_ls"] });
    assert.deepEqual([...ps.tools], ["sandbox_read", "sandbox_ls"]);
  });

  it("env() returns PI_SANDBOX_VERBS only (no PI_SANDBOX_ROOT)", () => {
    const ps = makeSandboxFs({ verbs: ["sandbox_read", "sandbox_grep"] });
    const env = ps.env({ cwd: "/some/cwd" });
    assert.equal(env.PI_SANDBOX_VERBS, "sandbox_read,sandbox_grep");
    assert.equal(env.PI_SANDBOX_ROOT, undefined);
  });

  it("spawnArgs is `['-e', <SANDBOX_FS_PATH>]`", () => {
    const ps = makeSandboxFs({ verbs: ["sandbox_ls"] });
    assert.deepEqual([...ps.spawnArgs], ["-e", SANDBOX_FS_PATH]);
    assert.match(SANDBOX_FS_PATH, /sandbox-fs\.ts$/);
  });

  it("name is 'sandbox-fs'", () => {
    const ps = makeSandboxFs({ verbs: ["sandbox_ls"] });
    assert.equal(ps.name, "sandbox-fs");
  });

  it("harvest is a no-op and finalize returns {}", () => {
    const ps = makeSandboxFs({ verbs: ["sandbox_ls"] });
    const state = ps.initialState();
    ps.harvest({} as Record<string, unknown>, state);
    const result = ps.finalize(state, {} as never);
    assert.deepEqual(result, {});
  });
});
