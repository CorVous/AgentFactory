// Tests for runAtomicDelegate — the testable core of the atomic delegate
// flow. The core handles: scratchRoot allocation, optional workspace
// bundling, dispatch-hook registration, race between submission/exit/
// timeout, and cleanup. Spawning is injected so tests don't fork node.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { realpathSync } from "node:fs";
import { runAtomicDelegate, type AtomicDelegateContext, type DispatchHookRegistry, type WorkerHandle, type SpawnArgs } from "./atomic-delegate";
import { buildWriteArtifact } from "./submission-emit";
import type { Artifact } from "./bus-envelope";

function makeMemoryRegistry(): DispatchHookRegistry & {
  trigger(workerName: string, artifacts: Artifact[]): boolean;
  has(workerName: string): boolean;
} {
  const hooks = new Map<string, (artifacts: Artifact[]) => void>();
  return {
    register(workerName, cb) {
      hooks.set(workerName, cb);
    },
    unregister(workerName) {
      hooks.delete(workerName);
    },
    trigger(workerName, artifacts) {
      const cb = hooks.get(workerName);
      if (!cb) return false;
      cb(artifacts);
      return true;
    },
    has(workerName) {
      return hooks.has(workerName);
    },
  };
}

interface FakeWorker extends WorkerHandle {
  killed: boolean;
  killSignals: NodeJS.Signals[];
  resolveExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
  spawnedArgs: SpawnArgs | null;
}

function makeSpawner() {
  let resolveExit: (code: number | null, signal?: NodeJS.Signals | null) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = (code, signal = null) => resolve({ code, signal: signal ?? null });
  });
  const fake: FakeWorker = {
    pid: 12345,
    exited,
    kill: vi.fn(),
    killed: false,
    killSignals: [],
    resolveExit,
    spawnedArgs: null,
  };
  fake.kill = (sig?: NodeJS.Signals) => {
    fake.killed = true;
    fake.killSignals.push(sig ?? "SIGTERM");
    fake.resolveExit(null, sig ?? "SIGTERM");
  };
  const spawnWorker = (args: SpawnArgs): WorkerHandle => {
    fake.spawnedArgs = args;
    return fake;
  };
  return { fake, spawnWorker };
}

const baseCtx = (overrides: Partial<AtomicDelegateContext> & {
  spawnWorker: AtomicDelegateContext["spawnWorker"];
  dispatchHookRegistry: AtomicDelegateContext["dispatchHookRegistry"];
}): AtomicDelegateContext => ({
  recipe: "deferred-writer",
  task: "draft hello.txt with hi",
  callerName: "captain-rabbit",
  callerSandbox: "/tmp/caller",
  busRoot: "/tmp/bus",
  ...overrides,
});

let createdScratchRoots: string[] = [];

afterEach(() => {
  for (const root of createdScratchRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  }
  createdScratchRoots = [];
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runAtomicDelegate — happy path", () => {
  it("returns artifacts when worker submits before exiting", async () => {
    const registry = makeMemoryRegistry();
    const { fake, spawnWorker } = makeSpawner();
    const ctx = baseCtx({
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker-1",
      timeoutMs: 5_000,
    });

    const promise = runAtomicDelegate(ctx);
    // Wait for the dispatch hook to be registered before triggering.
    await vi.waitFor(() => expect(registry.has("test-worker-1")).toBe(true));

    const artifacts: Artifact[] = [
      buildWriteArtifact({ relPath: "hello.txt", content: "hi" }),
      buildWriteArtifact({ relPath: "world.txt", content: "world" }),
    ];
    registry.trigger("test-worker-1", artifacts);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.workerName).toBe("test-worker-1");
    expect(result.artifacts).toEqual(artifacts);
    expect(fake.killed).toBe(true);
    expect(registry.has("test-worker-1")).toBe(false);
    createdScratchRoots.push(result.scratchRoot);
  });

  it("kills the worker after a successful submission", async () => {
    const registry = makeMemoryRegistry();
    const { fake, spawnWorker } = makeSpawner();
    const ctx = baseCtx({
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker-2",
      timeoutMs: 5_000,
    });
    const promise = runAtomicDelegate(ctx);
    await vi.waitFor(() => expect(registry.has("test-worker-2")).toBe(true));
    registry.trigger("test-worker-2", []);
    const result = await promise;
    expect(fake.killed).toBe(true);
    createdScratchRoots.push(result.scratchRoot);
  });

  it("passes the constructed habitat overlay to spawnWorker", async () => {
    const registry = makeMemoryRegistry();
    const { fake, spawnWorker } = makeSpawner();
    const ctx = baseCtx({
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker-3",
      timeoutMs: 5_000,
    });
    const promise = runAtomicDelegate(ctx);
    await vi.waitFor(() => expect(fake.spawnedArgs).not.toBeNull());
    registry.trigger("test-worker-3", []);
    const result = await promise;

    expect(fake.spawnedArgs).not.toBeNull();
    expect(fake.spawnedArgs!.workerName).toBe("test-worker-3");
    expect(fake.spawnedArgs!.recipe).toBe("deferred-writer");
    expect(fake.spawnedArgs!.busRoot).toBe("/tmp/bus");
    expect(fake.spawnedArgs!.task).toBe("draft hello.txt with hi");
    expect(fake.spawnedArgs!.habitatOverlay).toEqual({
      supervisor: "captain-rabbit",
      submitTo: "captain-rabbit",
      acceptedFrom: ["captain-rabbit"],
      peers: ["captain-rabbit"],
      agents: [],
    });
    createdScratchRoots.push(result.scratchRoot);
  });
});

// ---------------------------------------------------------------------------
// Worker exits before submitting
// ---------------------------------------------------------------------------

describe("runAtomicDelegate — worker exits without submission", () => {
  it("returns ok=false with error when worker exits cleanly with no submission", async () => {
    const registry = makeMemoryRegistry();
    const { fake, spawnWorker } = makeSpawner();
    const ctx = baseCtx({
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker-exit",
      timeoutMs: 5_000,
    });
    const promise = runAtomicDelegate(ctx);
    await vi.waitFor(() => expect(registry.has("test-worker-exit")).toBe(true));
    fake.resolveExit(0, null);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.workerName).toBe("test-worker-exit");
    expect(result.artifacts).toEqual([]);
    expect(result.error).toMatch(/exited without submission/i);
    expect(registry.has("test-worker-exit")).toBe(false);
    createdScratchRoots.push(result.scratchRoot);
  });

  it("returns ok=false with error when worker crashes", async () => {
    const registry = makeMemoryRegistry();
    const { fake, spawnWorker } = makeSpawner();
    const ctx = baseCtx({
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker-crash",
      timeoutMs: 5_000,
    });
    const promise = runAtomicDelegate(ctx);
    await vi.waitFor(() => expect(registry.has("test-worker-crash")).toBe(true));
    fake.resolveExit(1, null);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.artifacts).toEqual([]);
    expect(result.error).toMatch(/exited without submission/i);
    createdScratchRoots.push(result.scratchRoot);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("runAtomicDelegate — timeout", () => {
  it("kills the worker and returns ok=false with timeout error when no submission arrives", async () => {
    const registry = makeMemoryRegistry();
    const { fake, spawnWorker } = makeSpawner();
    const ctx = baseCtx({
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker-timeout",
      timeoutMs: 50,
    });
    const result = await runAtomicDelegate(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(fake.killed).toBe(true);
    expect(registry.has("test-worker-timeout")).toBe(false);
    createdScratchRoots.push(result.scratchRoot);
  });
});

// ---------------------------------------------------------------------------
// Workspace bundling
// ---------------------------------------------------------------------------

describe("runAtomicDelegate — workspace bundling", () => {
  let callerSandbox: string;
  beforeEach(() => {
    callerSandbox = mkdtempSync(join(tmpdir(), "atomic-delegate-caller-"));
  });
  afterEach(() => {
    try { rmSync(callerSandbox, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it("copies files matching workspace.include into the worker scratchRoot", async () => {
    const aPath = join(callerSandbox, "a.txt");
    const subPath = join(callerSandbox, "sub", "b.txt");
    const skipPath = join(callerSandbox, "skip.md");
    mkdirSync(dirname(subPath), { recursive: true });
    writeFileSync(aPath, "alpha", "utf8");
    writeFileSync(subPath, "beta", "utf8");
    writeFileSync(skipPath, "gamma", "utf8");

    const registry = makeMemoryRegistry();
    const { fake, spawnWorker } = makeSpawner();
    const ctx = baseCtx({
      callerSandbox,
      workspace: { include: ["a.txt", "sub/b.txt"] },
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker-ws",
      timeoutMs: 5_000,
    });

    const promise = runAtomicDelegate(ctx);
    await vi.waitFor(() => expect(fake.spawnedArgs).not.toBeNull());
    const scratch = fake.spawnedArgs!.scratchRoot;
    createdScratchRoots.push(scratch);

    expect(existsSync(join(scratch, "a.txt"))).toBe(true);
    expect(readFileSync(join(scratch, "a.txt"), "utf8")).toBe("alpha");
    expect(existsSync(join(scratch, "sub", "b.txt"))).toBe(true);
    expect(readFileSync(join(scratch, "sub", "b.txt"), "utf8")).toBe("beta");
    expect(existsSync(join(scratch, "skip.md"))).toBe(false);

    registry.trigger("test-worker-ws", []);
    await promise;
  });

  it("accepts an empty workspace.include without error", async () => {
    const registry = makeMemoryRegistry();
    const { fake, spawnWorker } = makeSpawner();
    const ctx = baseCtx({
      callerSandbox,
      workspace: { include: [] },
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker-ws-empty",
      timeoutMs: 5_000,
    });
    const promise = runAtomicDelegate(ctx);
    await vi.waitFor(() => expect(fake.spawnedArgs).not.toBeNull());
    createdScratchRoots.push(fake.spawnedArgs!.scratchRoot);
    registry.trigger("test-worker-ws-empty", []);
    const result = await promise;
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sandbox containment
// ---------------------------------------------------------------------------

describe("runAtomicDelegate — sandbox containment", () => {
  it("creates a fresh scratchRoot under the OS tmpdir", async () => {
    const registry = makeMemoryRegistry();
    const { fake, spawnWorker } = makeSpawner();
    const ctx = baseCtx({
      callerSandbox: "/tmp/some-caller",
      spawnWorker,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker-sandbox",
      timeoutMs: 5_000,
    });
    const promise = runAtomicDelegate(ctx);
    await vi.waitFor(() => expect(fake.spawnedArgs).not.toBeNull());
    const scratch = fake.spawnedArgs!.scratchRoot;
    createdScratchRoots.push(scratch);

    const tmpReal = realpathSync(tmpdir());
    const scratchReal = realpathSync(scratch);
    expect(scratchReal === tmpReal || scratchReal.startsWith(tmpReal + sep)).toBe(true);
    expect(scratchReal).not.toBe("/tmp/some-caller");
    expect(existsSync(scratch)).toBe(true);

    registry.trigger("test-worker-sandbox", []);
    await promise;
  });

  it("uses a different scratchRoot per call", async () => {
    const registry = makeMemoryRegistry();
    const { fake: fake1, spawnWorker: spawn1 } = makeSpawner();
    const { fake: fake2, spawnWorker: spawn2 } = makeSpawner();

    const ctx1 = baseCtx({
      spawnWorker: spawn1,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker-a",
      timeoutMs: 5_000,
    });
    const ctx2 = baseCtx({
      spawnWorker: spawn2,
      dispatchHookRegistry: registry,
      nameGenerator: () => "test-worker-b",
      timeoutMs: 5_000,
    });

    const p1 = runAtomicDelegate(ctx1);
    const p2 = runAtomicDelegate(ctx2);
    await vi.waitFor(() => expect(fake1.spawnedArgs).not.toBeNull());
    await vi.waitFor(() => expect(fake2.spawnedArgs).not.toBeNull());

    expect(fake1.spawnedArgs!.scratchRoot).not.toBe(fake2.spawnedArgs!.scratchRoot);
    createdScratchRoots.push(fake1.spawnedArgs!.scratchRoot, fake2.spawnedArgs!.scratchRoot);

    registry.trigger("test-worker-a", []);
    registry.trigger("test-worker-b", []);
    await Promise.all([p1, p2]);
  });
});
