// peer-spawn.test.ts — hermetic unit tests for the shared spawn library.
// No model calls, no network, no real child processes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeWorkerHabitatOverlay,
  serializeHabitatOverlay,
  copyWorkspace,
  runAtomicDelegate,
  runMeshSpawn,
  type WorkerHandle,
  type SpawnArgs,
  type DispatchHookRegistry,
  type PeerSpawnContext,
  type MeshSpawnContext,
} from "./peer-spawn.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Create a tmpdir, return its path. */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "peer-spawn-test-"));
}

/** Build a simple in-memory dispatch-hook registry. */
function makeRegistry(): DispatchHookRegistry & {
  fire(workerName: string, artifacts: import("./bus-envelope.js").Artifact[]): void;
} {
  const hooks = new Map<string, (artifacts: import("./bus-envelope.js").Artifact[]) => void>();
  return {
    register(name, cb) { hooks.set(name, cb); },
    unregister(name) { hooks.delete(name); },
    fire(name, artifacts) { hooks.get(name)?.(artifacts); },
  };
}

/** Build a fake WorkerHandle that never exits (unless explicitly resolved). */
function makePendingHandle(): WorkerHandle & { resolve: (code?: number) => void } {
  let resolveExit!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    resolveExit = res;
  });
  const killMock = vi.fn();
  return {
    pid: 1234,
    exited,
    kill: killMock,
    resolve: (code = 0) => resolveExit({ code, signal: null }),
  };
}

/** Build a fake WorkerHandle that exits immediately with the given code. */
function makeExitedHandle(code = 0): WorkerHandle {
  return {
    pid: 999,
    exited: Promise.resolve({ code, signal: null }),
    kill: vi.fn(),
  };
}

// ── computeWorkerHabitatOverlay ───────────────────────────────────────────

describe("computeWorkerHabitatOverlay", () => {
  it("returns an overlay with the caller as all peer fields", () => {
    const overlay = computeWorkerHabitatOverlay("caller-agent");
    expect(overlay.supervisor).toBe("caller-agent");
    expect(overlay.submitsWorkTo).toBe("caller-agent");
    expect(overlay.acceptsWorkFrom).toEqual(["caller-agent"]);
    expect(overlay.messagesWith).toEqual(["caller-agent"]);
    expect(overlay.spawns).toEqual([]);
  });

  it("uses new vocabulary field names (not old agent/submitTo/peers)", () => {
    const overlay = computeWorkerHabitatOverlay("parent");
    expect("submitTo" in overlay).toBe(false);
    expect("agents" in overlay).toBe(false);
    expect("peers" in overlay).toBe(false);
    expect("acceptedFrom" in overlay).toBe(false);
  });
});

// ── serializeHabitatOverlay ──────────────────────────────────────────────

describe("serializeHabitatOverlay", () => {
  it("maps supervisor → escalatesTo in the JSON output", () => {
    const overlay = computeWorkerHabitatOverlay("boss");
    const json = JSON.parse(serializeHabitatOverlay(overlay));
    expect(json.escalatesTo).toBe("boss");
    expect("supervisor" in json).toBe(false);
  });

  it("serializes submitsWorkTo, acceptsWorkFrom, messagesWith, spawns", () => {
    const overlay = computeWorkerHabitatOverlay("boss");
    const json = JSON.parse(serializeHabitatOverlay(overlay));
    expect(json.submitsWorkTo).toBe("boss");
    expect(json.acceptsWorkFrom).toEqual(["boss"]);
    expect(json.messagesWith).toEqual(["boss"]);
    expect(json.spawns).toEqual([]);
  });
});

// ── copyWorkspace ────────────────────────────────────────────────────────

describe("copyWorkspace", () => {
  it("copies a single file into scratchRoot preserving relative path", () => {
    const callerSandbox = makeTmpDir();
    const scratchRoot = makeTmpDir();
    fs.writeFileSync(path.join(callerSandbox, "hello.txt"), "hi");
    copyWorkspace(callerSandbox, scratchRoot, ["hello.txt"]);
    expect(fs.existsSync(path.join(scratchRoot, "hello.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(scratchRoot, "hello.txt"), "utf8")).toBe("hi");
  });

  it("recursively copies a subdirectory", () => {
    const callerSandbox = makeTmpDir();
    const scratchRoot = makeTmpDir();
    const subdir = path.join(callerSandbox, "sub");
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, "file.ts"), "content");
    copyWorkspace(callerSandbox, scratchRoot, ["sub"]);
    expect(fs.existsSync(path.join(scratchRoot, "sub", "file.ts"))).toBe(true);
  });

  it("silently skips paths that escape the caller sandbox", () => {
    const callerSandbox = makeTmpDir();
    const scratchRoot = makeTmpDir();
    // Escape attempt via ../
    copyWorkspace(callerSandbox, scratchRoot, ["../etc/passwd"]);
    expect(fs.readdirSync(scratchRoot)).toHaveLength(0);
  });

  it("silently skips non-existent paths", () => {
    const callerSandbox = makeTmpDir();
    const scratchRoot = makeTmpDir();
    copyWorkspace(callerSandbox, scratchRoot, ["nonexistent.txt"]);
    expect(fs.readdirSync(scratchRoot)).toHaveLength(0);
  });

  it("empty include list results in no files copied", () => {
    const callerSandbox = makeTmpDir();
    const scratchRoot = makeTmpDir();
    copyWorkspace(callerSandbox, scratchRoot, []);
    expect(fs.readdirSync(scratchRoot)).toHaveLength(0);
  });
});

// ── runAtomicDelegate ─────────────────────────────────────────────────────

describe("runAtomicDelegate", () => {
  it("happy path: returns artifacts when worker sends submission", async () => {
    const registry = makeRegistry();
    const handle = makePendingHandle();
    const artifacts: import("./bus-envelope.js").Artifact[] = [
      { kind: "write", relPath: "hello.txt", content: "hi", sha256: "abc" },
    ];
    const callerSandbox = makeTmpDir();

    const spawnWorker = vi.fn((_args: SpawnArgs) => {
      setTimeout(() => registry.fire(_args.workerName, artifacts), 10);
      return handle as WorkerHandle;
    });

    const ctx: PeerSpawnContext = {
      recipe: "deferred-writer",
      task: "draft something",
      callerName: "foreman",
      callerSandbox,
      busRoot: "/tmp/bus",
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker",
    };

    const result = await runAtomicDelegate(ctx);
    expect(result.ok).toBe(true);
    expect(result.artifacts).toEqual(artifacts);
    expect(result.workerName).toBe("test-worker");
    expect(result.scratchRoot).toBeTruthy();
    // scratchRoot is created
    expect(fs.existsSync(result.scratchRoot)).toBe(true);
    // cleanup
    fs.rmSync(result.scratchRoot, { recursive: true, force: true });
  });

  it("returns error when worker exits without submission", async () => {
    const registry = makeRegistry();
    const handle = makeExitedHandle(1);
    const callerSandbox = makeTmpDir();

    const spawnWorker = vi.fn((_args: SpawnArgs) => handle);

    const ctx: PeerSpawnContext = {
      recipe: "deferred-writer",
      task: "draft",
      callerName: "foreman",
      callerSandbox,
      busRoot: "/tmp/bus",
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "dying-worker",
    };

    const result = await runAtomicDelegate(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited without submission/);
    expect(result.artifacts).toEqual([]);
    fs.rmSync(result.scratchRoot, { recursive: true, force: true });
  });

  it("times out and kills worker when no submission arrives within timeoutMs", async () => {
    const registry = makeRegistry();
    const handle = makePendingHandle();
    const killMock = handle.kill as ReturnType<typeof vi.fn>;
    const callerSandbox = makeTmpDir();

    const spawnWorker = vi.fn((_args: SpawnArgs) => handle as WorkerHandle);

    const ctx: PeerSpawnContext = {
      recipe: "deferred-writer",
      task: "draft",
      callerName: "foreman",
      callerSandbox,
      busRoot: "/tmp/bus",
      spawnWorker,
      dispatchHookRegistry: registry,
      timeoutMs: 50, // very short timeout
      nameGenerator: () => "slow-worker",
    };

    const result = await runAtomicDelegate(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(killMock).toHaveBeenCalled();
    fs.rmSync(result.scratchRoot, { recursive: true, force: true });
  }, 5000);

  it("copies workspace files into scratchRoot before spawning", async () => {
    const registry = makeRegistry();
    const callerSandbox = makeTmpDir();
    fs.writeFileSync(path.join(callerSandbox, "context.md"), "important");

    let capturedScratchRoot = "";
    const artifacts: import("./bus-envelope.js").Artifact[] = [
      { kind: "write", relPath: "out.txt", content: "done", sha256: "xyz" },
    ];
    const spawnWorker = vi.fn((args: SpawnArgs) => {
      capturedScratchRoot = args.scratchRoot;
      const h = makePendingHandle();
      setTimeout(() => registry.fire(args.workerName, artifacts), 10);
      return h as WorkerHandle;
    });

    const ctx: PeerSpawnContext = {
      recipe: "deferred-writer",
      task: "use the context",
      callerName: "foreman",
      callerSandbox,
      busRoot: "/tmp/bus",
      workspace: { include: ["context.md"] },
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "workspace-worker",
    };

    const result = await runAtomicDelegate(ctx);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(capturedScratchRoot, "context.md"))).toBe(true);
    fs.rmSync(result.scratchRoot, { recursive: true, force: true });
  });

  it("scratchRoot uniqueness: two concurrent calls produce different roots", async () => {
    const registry1 = makeRegistry();
    const registry2 = makeRegistry();
    const callerSandbox = makeTmpDir();

    const artifacts: import("./bus-envelope.js").Artifact[] = [];
    let n = 0;

    const makeSpawner = (reg: typeof registry1) =>
      vi.fn((args: SpawnArgs) => {
        const h = makePendingHandle();
        setTimeout(() => reg.fire(args.workerName, artifacts), 10);
        return h as WorkerHandle;
      });

    const ctx1: PeerSpawnContext = {
      recipe: "r",
      task: "t",
      callerName: "c",
      callerSandbox,
      busRoot: "/tmp/bus",
      spawnWorker: makeSpawner(registry1),
      dispatchHookRegistry: registry1,
      nameGenerator: () => `worker-${++n}`,
    };
    const ctx2: PeerSpawnContext = {
      ...ctx1,
      spawnWorker: makeSpawner(registry2),
      dispatchHookRegistry: registry2,
    };

    const [r1, r2] = await Promise.all([
      runAtomicDelegate(ctx1),
      runAtomicDelegate(ctx2),
    ]);
    expect(r1.scratchRoot).not.toBe(r2.scratchRoot);
    fs.rmSync(r1.scratchRoot, { recursive: true, force: true });
    fs.rmSync(r2.scratchRoot, { recursive: true, force: true });
  });
});

// ── runMeshSpawn ─────────────────────────────────────────────────────────

describe("runMeshSpawn", () => {
  it("returns ok:true with the worker handle and scratchRoot", async () => {
    const callerSandbox = makeTmpDir();
    const handle = makePendingHandle();
    const spawnWorker = vi.fn((_args: SpawnArgs) => handle as WorkerHandle);

    const ctx: MeshSpawnContext = {
      recipe: "mesh-node",
      workerName: "my-node",
      busRoot: "/tmp/bus",
      task: "monitor logs",
      callerSandbox,
      callerName: "authority",
      spawnWorker,
    };

    const result = await runMeshSpawn(ctx);
    expect(result.ok).toBe(true);
    expect(result.workerName).toBe("my-node");
    expect(result.scratchRoot).toBeTruthy();
    expect(fs.existsSync(result.scratchRoot)).toBe(true);
    expect(result.handle).toBe(handle);
    expect(spawnWorker).toHaveBeenCalledOnce();
    fs.rmSync(result.scratchRoot, { recursive: true, force: true });
  });

  it("returns ok:false and cleans up scratchRoot when spawnWorker throws", async () => {
    const callerSandbox = makeTmpDir();
    const spawnWorker = vi.fn((_args: SpawnArgs) => {
      throw new Error("binary not found");
    });

    const ctx: MeshSpawnContext = {
      recipe: "mesh-node",
      workerName: "failing-node",
      busRoot: "/tmp/bus",
      callerSandbox,
      callerName: "authority",
      spawnWorker,
    };

    const result = await runMeshSpawn(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/spawn failed.*binary not found/);
    // scratchRoot should be cleaned up
    expect(fs.existsSync(result.scratchRoot)).toBe(false);
  });

  it("passes the correct habitatOverlay to spawnWorker", async () => {
    const callerSandbox = makeTmpDir();
    let capturedArgs: SpawnArgs | null = null;
    const handle = makePendingHandle();
    const spawnWorker = vi.fn((args: SpawnArgs) => {
      capturedArgs = args;
      return handle as WorkerHandle;
    });

    const ctx: MeshSpawnContext = {
      recipe: "mesh-node",
      workerName: "wired-node",
      busRoot: "/tmp/mybus",
      callerSandbox,
      callerName: "orchestrator",
      spawnWorker,
    };

    await runMeshSpawn(ctx);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.habitatOverlay.supervisor).toBe("orchestrator");
    expect(capturedArgs!.habitatOverlay.submitsWorkTo).toBe("orchestrator");
    expect(capturedArgs!.habitatOverlay.acceptsWorkFrom).toEqual(["orchestrator"]);
    expect(capturedArgs!.habitatOverlay.messagesWith).toEqual(["orchestrator"]);
    expect(capturedArgs!.habitatOverlay.spawns).toEqual([]);
    fs.rmSync(capturedArgs!.scratchRoot, { recursive: true, force: true });
  });

  it("two calls produce different scratchRoot paths", async () => {
    const callerSandbox = makeTmpDir();
    const handles = [makePendingHandle(), makePendingHandle()];
    let i = 0;
    const spawnWorker = vi.fn((_args: SpawnArgs) => handles[i++] as WorkerHandle);

    const makeCtx = (name: string): MeshSpawnContext => ({
      recipe: "mesh-node",
      workerName: name,
      busRoot: "/tmp/bus",
      callerSandbox,
      callerName: "authority",
      spawnWorker,
    });

    const [r1, r2] = await Promise.all([
      runMeshSpawn(makeCtx("n1")),
      runMeshSpawn(makeCtx("n2")),
    ]);
    expect(r1.scratchRoot).not.toBe(r2.scratchRoot);
    fs.rmSync(r1.scratchRoot, { recursive: true, force: true });
    fs.rmSync(r2.scratchRoot, { recursive: true, force: true });
  });

  it("copies workspace files into scratchRoot before spawning", async () => {
    const callerSandbox = makeTmpDir();
    fs.writeFileSync(path.join(callerSandbox, "ref.md"), "reference content");
    let capturedScratch = "";
    const handle = makePendingHandle();
    const spawnWorker = vi.fn((args: SpawnArgs) => {
      capturedScratch = args.scratchRoot;
      return handle as WorkerHandle;
    });

    const ctx: MeshSpawnContext = {
      recipe: "mesh-node",
      workerName: "ws-node",
      busRoot: "/tmp/bus",
      workspace: { include: ["ref.md"] },
      callerSandbox,
      callerName: "authority",
      spawnWorker,
    };

    await runMeshSpawn(ctx);
    expect(fs.existsSync(path.join(capturedScratch, "ref.md"))).toBe(true);
    fs.rmSync(capturedScratch, { recursive: true, force: true });
  });
});
