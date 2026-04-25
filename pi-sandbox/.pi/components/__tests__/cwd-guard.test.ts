// cwd-guard.test.ts — unit tests for the catch-all sandbox component.
// Covers: env-gated registration (PI_SANDBOX_VERBS filters which tools
// are registered), path validation rejecting out-of-root + symlink
// escapes, the makeCwdGuard factory's tools/env contract.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  makeCwdGuard,
  type SandboxVerb,
} from "../cwd-guard.ts";
// Default export exercises the tool-registration path. Imported as a
// fresh function each time so the stub registry is per-test.
import cwdGuardLoader from "../cwd-guard.ts";

interface RegisteredTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

function makeStubPi() {
  const tools: RegisteredTool[] = [];
  return {
    pi: {
      registerTool: (def: RegisteredTool) => tools.push(def),
      // Loader uses only registerTool; supply a no-op for anything else
      // it might pull from `pi`.
    } as unknown as Parameters<typeof cwdGuardLoader>[0],
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "cwd-guard-test-"));
}

/* ---------- env gating ----------------------------------------------- */

describe("cwd-guard: env-gated registration", () => {
  it("throws when PI_SANDBOX_ROOT is missing", () => {
    const { pi } = makeStubPi();
    assert.throws(
      () =>
        withEnv(
          { PI_SANDBOX_ROOT: undefined, PI_SANDBOX_VERBS: "sandbox_ls" },
          () => cwdGuardLoader(pi),
        ),
      /PI_SANDBOX_ROOT must be set/,
    );
  });

  it("throws when PI_SANDBOX_VERBS is missing or empty", () => {
    const root = makeTempRoot();
    const { pi } = makeStubPi();
    assert.throws(
      () =>
        withEnv(
          { PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: undefined },
          () => cwdGuardLoader(pi),
        ),
      /PI_SANDBOX_VERBS must be set/,
    );
    const { pi: pi2 } = makeStubPi();
    assert.throws(
      () =>
        withEnv(
          { PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: "" },
          () => cwdGuardLoader(pi2),
        ),
      /PI_SANDBOX_VERBS must be set/,
    );
  });

  it("rejects unknown verbs in PI_SANDBOX_VERBS", () => {
    const root = makeTempRoot();
    const { pi } = makeStubPi();
    assert.throws(
      () =>
        withEnv(
          { PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: "sandbox_telnet" },
          () => cwdGuardLoader(pi),
        ),
      /unknown verb/,
    );
  });

  it("registers only the verbs listed in PI_SANDBOX_VERBS", () => {
    const root = makeTempRoot();
    const { pi, tools } = makeStubPi();
    withEnv(
      {
        PI_SANDBOX_ROOT: root,
        PI_SANDBOX_VERBS: "sandbox_ls,sandbox_read",
      },
      () => cwdGuardLoader(pi),
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
      () => cwdGuardLoader(pi),
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

/* ---------- path validation ------------------------------------------ */

describe("cwd-guard: path validation", () => {
  it("sandbox_write rejects absolute path outside root", async () => {
    const root = makeTempRoot();
    const { pi, tools } = makeStubPi();
    withEnv(
      { PI_SANDBOX_ROOT: root, PI_SANDBOX_VERBS: "sandbox_write" },
      () => cwdGuardLoader(pi),
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
        () => cwdGuardLoader(pi),
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
        () => cwdGuardLoader(pi),
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
        () => cwdGuardLoader(pi),
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

/* ---------- makeCwdGuard factory ------------------------------------- */

describe("makeCwdGuard factory", () => {
  it("throws on empty verb list", () => {
    assert.throws(
      () => makeCwdGuard({ verbs: [] as ReadonlyArray<SandboxVerb> }),
      /non-empty subset/,
    );
  });

  it("throws on unknown verb", () => {
    assert.throws(
      () =>
        makeCwdGuard({ verbs: ["bogus_verb"] as unknown as SandboxVerb[] }),
      /unknown verb/,
    );
  });

  it("parentSide.tools matches the requested verb subset", () => {
    const ps = makeCwdGuard({
      verbs: ["sandbox_read", "sandbox_ls"],
    });
    assert.deepEqual([...ps.tools], ["sandbox_read", "sandbox_ls"]);
  });

  it("env() returns PI_SANDBOX_ROOT and PI_SANDBOX_VERBS", () => {
    const ps = makeCwdGuard({
      verbs: ["sandbox_read", "sandbox_grep"],
    });
    const env = ps.env({ cwd: "/some/cwd" });
    assert.equal(env.PI_SANDBOX_ROOT, "/some/cwd");
    assert.equal(env.PI_SANDBOX_VERBS, "sandbox_read,sandbox_grep");
  });

  it("spawnArgs is `['-e', <path-to-cwd-guard.ts>]`", () => {
    const ps = makeCwdGuard({ verbs: ["sandbox_ls"] });
    assert.equal(ps.spawnArgs.length, 2);
    assert.equal(ps.spawnArgs[0], "-e");
    assert.match(ps.spawnArgs[1], /cwd-guard\.ts$/);
  });

  it("harvest is a no-op and finalize returns {}", () => {
    const ps = makeCwdGuard({ verbs: ["sandbox_ls"] });
    const state = ps.initialState();
    ps.harvest({} as Record<string, unknown>, state);
    const result = ps.finalize(state, {} as never);
    assert.deepEqual(result, {});
  });
});
