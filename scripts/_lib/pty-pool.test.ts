/**
 * pty-pool.test.ts — hermetic unit tests for PtyPool lifecycle state machine.
 *
 * No real PTY allocation. The spawnFn is injected as a mock that returns
 * a fake PTY object with controllable onData / onExit callbacks.
 *
 * Coverage:
 *   - spawn creates a peer with state "running"
 *   - spawn throws on duplicate name
 *   - getStatus / getBuffer / listPeers
 *   - output event fires on PTY data
 *   - exit event fires when PTY exits
 *   - state transitions: running → exiting → exited
 *   - resize calls through to the mock PTY
 *   - resizeAll propagates to all peers
 *   - kill transitions to exiting then exited
 *   - write calls through to the mock PTY
 */

import { describe, it, expect, vi } from "vitest";
import { createPtyPool, PtyPool } from "./pty-pool.mjs";

// ── mock PTY factory ──────────────────────────────────────────────────────────

/**
 * Creates a fake PTY object that exposes controllable callbacks.
 * The returned object also has .simulateData() and .simulateExit() helpers
 * for driving the mock from tests.
 */
function makeMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((info: { exitCode: number; signal: string }) => void) | null = null;

  const pty = {
    onData: (cb: (data: string) => void) => { dataHandler = cb; },
    onExit: (cb: (info: { exitCode: number; signal: string }) => void) => { exitHandler = cb; },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    // test helpers
    simulateData: (data: string) => dataHandler?.(data),
    simulateExit: (exitCode = 0, signal = "") => exitHandler?.({ exitCode, signal }),
  };
  return pty;
}

type MockPty = ReturnType<typeof makeMockPty>;

/**
 * Build a PtyPool with a controllable spawn function.
 * Returns both the pool and a map of spawned mock PTYs keyed by name.
 */
function buildPool() {
  const mockPtys = new Map<string, MockPty>();
  let spawnCallCount = 0;

  const spawnFn = (_cmd: string, _args: string[], _opts: Record<string, unknown>) => {
    const pty = makeMockPty();
    // Use spawn call order as key; caller can name it later.
    spawnCallCount++;
    // Store under a counter; test helpers will grab by name after spawn.
    mockPtys.set(`__spawn_${spawnCallCount}`, pty);
    return pty;
  };

  const pool = createPtyPool({ spawnFn });
  return { pool, mockPtys };
}

/** Spawn a peer and return the mock PTY (by matching latest entry in mockPtys). */
function spawnPeer(pool: PtyPool, mockPtys: Map<string, MockPty>, name: string) {
  const vb = pool.spawn({
    name,
    cmd: "/bin/pi",
    args: [],
    cols: 80,
    rows: 24,
  });
  // The mock PTY is the last one added.
  const keys = [...mockPtys.keys()];
  const pty = mockPtys.get(keys[keys.length - 1])!;
  return { vb, pty };
}

// ── spawn ─────────────────────────────────────────────────────────────────────

describe("spawn", () => {
  it("returns a VirtualBuffer on success", () => {
    const { pool, mockPtys } = buildPool();
    const { vb } = spawnPeer(pool, mockPtys, "peer-a");
    expect(vb).toBeDefined();
    expect(typeof vb.paint).toBe("function");
  });

  it("sets state to 'running' immediately after spawn", () => {
    const { pool, mockPtys } = buildPool();
    spawnPeer(pool, mockPtys, "peer-a");
    const status = pool.getStatus("peer-a");
    expect(status?.state).toBe("running");
  });

  it("throws on duplicate peer name", () => {
    const { pool, mockPtys } = buildPool();
    spawnPeer(pool, mockPtys, "peer-a");
    expect(() =>
      pool.spawn({ name: "peer-a", cmd: "/bin/pi", args: [], cols: 80, rows: 24 })
    ).toThrow("peer-a");
  });

  it("emits 'error' event with (name, err) when the spawnFn throws", () => {
    const bindingError = new Error("native binding mismatch");
    const spawnFn = () => { throw bindingError; };
    const pool = createPtyPool({ spawnFn });

    const errors: Array<{ name: string; err: Error }> = [];
    pool.on("error", (name: string, err: Error) => errors.push({ name, err }));

    expect(() =>
      pool.spawn({ name: "peer-x", cmd: "/bin/pi", args: [], cols: 80, rows: 24 })
    ).toThrow("native binding mismatch");

    expect(errors).toHaveLength(1);
    expect(errors[0].name).toBe("peer-x");
    expect(errors[0].err).toBe(bindingError);
  });

  it("registers the peer in listPeers()", () => {
    const { pool, mockPtys } = buildPool();
    spawnPeer(pool, mockPtys, "alpha");
    spawnPeer(pool, mockPtys, "beta");
    const peers = pool.listPeers();
    expect(peers).toContain("alpha");
    expect(peers).toContain("beta");
  });

  it("getBuffer returns the VirtualBuffer for a spawned peer", () => {
    const { pool, mockPtys } = buildPool();
    const { vb } = spawnPeer(pool, mockPtys, "peer-a");
    expect(pool.getBuffer("peer-a")).toBe(vb);
  });

  it("getBuffer returns undefined for unknown peer", () => {
    const { pool } = buildPool();
    expect(pool.getBuffer("nobody")).toBeUndefined();
  });

  it("getStatus returns undefined for unknown peer", () => {
    const { pool } = buildPool();
    expect(pool.getStatus("nobody")).toBeUndefined();
  });
});

// ── output event ──────────────────────────────────────────────────────────────

describe("output event", () => {
  it("fires 'output' event with peer name and data when PTY emits data", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");

    const received: Array<{ name: string; data: string }> = [];
    pool.on("output", (name: string, data: string) => received.push({ name, data }));

    pty.simulateData("hello from pty");

    expect(received).toHaveLength(1);
    expect(received[0].name).toBe("peer-a");
    expect(received[0].data).toBe("hello from pty");
  });

  it("output events from different peers carry correct names", () => {
    const { pool, mockPtys } = buildPool();
    const { pty: ptyA } = spawnPeer(pool, mockPtys, "peer-a");
    const { pty: ptyB } = spawnPeer(pool, mockPtys, "peer-b");

    const received: Array<{ name: string; data: string }> = [];
    pool.on("output", (name: string, data: string) => received.push({ name, data }));

    ptyA.simulateData("from-a");
    ptyB.simulateData("from-b");

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ name: "peer-a", data: "from-a" });
    expect(received[1]).toEqual({ name: "peer-b", data: "from-b" });
  });
});

// ── exit event ────────────────────────────────────────────────────────────────

describe("exit event", () => {
  it("fires 'exit' event when PTY exits", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");

    const exits: Array<{ name: string; code: number | null; signal: string | null }> = [];
    pool.on("exit", (name: string, code: number | null, signal: string | null) => {
      exits.push({ name, code, signal });
    });

    pty.simulateExit(0, "");

    expect(exits).toHaveLength(1);
    expect(exits[0].name).toBe("peer-a");
    expect(exits[0].code).toBe(0);
  });

  it("transitions state to 'exited' after PTY exit", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");
    pty.simulateExit(1, "");
    expect(pool.getStatus("peer-a")?.state).toBe("exited");
  });

  it("stores exitCode in status after exit", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");
    pty.simulateExit(42, "");
    expect(pool.getStatus("peer-a")?.exitCode).toBe(42);
  });
});

// ── crash event ───────────────────────────────────────────────────────────────

describe("crash event", () => {
  it("fires 'crash' event with typed payload when PTY exits with non-zero code", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");

    const crashes: Array<{ peer: string; exitCode: number | null; signal: string | null }> = [];
    pool.on("crash", (ev: { peer: string; exitCode: number | null; signal: string | null }) => {
      crashes.push(ev);
    });

    pty.simulateExit(1, "");

    expect(crashes).toHaveLength(1);
    expect(crashes[0].peer).toBe("peer-a");
    expect(crashes[0].exitCode).toBe(1);
    expect(crashes[0].signal).toBeNull();
  });

  it("fires 'crash' event with typed payload when PTY exits with a signal", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");

    const crashes: Array<{ peer: string; exitCode: number | null; signal: string | null }> = [];
    pool.on("crash", (ev: { peer: string; exitCode: number | null; signal: string | null }) => {
      crashes.push(ev);
    });

    pty.simulateExit(0, "SIGTERM");

    expect(crashes).toHaveLength(1);
    expect(crashes[0].peer).toBe("peer-a");
    expect(crashes[0].signal).toBe("SIGTERM");
  });

  it("does NOT fire 'crash' event when PTY exits cleanly (code=0, no signal)", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");

    const crashes: unknown[] = [];
    pool.on("crash", (ev: unknown) => crashes.push(ev));

    pty.simulateExit(0, "");

    expect(crashes).toHaveLength(0);
  });

  it("crash event payload has peer, exitCode, signal fields", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");

    let crashEvent: { peer: string; exitCode: number | null; signal: string | null } | null = null;
    pool.on("crash", (ev: { peer: string; exitCode: number | null; signal: string | null }) => {
      crashEvent = ev;
    });

    pty.simulateExit(2, "SIGKILL");

    expect(crashEvent).not.toBeNull();
    expect(crashEvent!.peer).toBe("peer-a");
    expect(crashEvent!.exitCode).toBe(2);
    expect(crashEvent!.signal).toBe("SIGKILL");
  });

  it("crash event still fires 'exit' event too (both always emitted on crash)", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");

    const exits: unknown[] = [];
    const crashes: unknown[] = [];
    pool.on("exit", (name: string) => exits.push(name));
    pool.on("crash", (ev: unknown) => crashes.push(ev));

    pty.simulateExit(1, "");

    expect(exits).toHaveLength(1);
    expect(crashes).toHaveLength(1);
  });
});

// ── resize ────────────────────────────────────────────────────────────────────

describe("resize", () => {
  it("calls resize() on the mock PTY", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");
    pool.resize("peer-a", 160, 50);
    expect(pty.resize).toHaveBeenCalledWith(160, 50);
  });

  it("updates the VirtualBuffer dimensions", () => {
    const { pool, mockPtys } = buildPool();
    const { vb } = spawnPeer(pool, mockPtys, "peer-a");
    pool.resize("peer-a", 160, 50);
    expect(vb.cols).toBe(160);
    expect(vb.rows).toBe(50);
  });

  it("resizeAll resizes all peers", () => {
    const { pool, mockPtys } = buildPool();
    const { pty: ptyA } = spawnPeer(pool, mockPtys, "peer-a");
    const { pty: ptyB } = spawnPeer(pool, mockPtys, "peer-b");
    pool.resizeAll(200, 60);
    expect(ptyA.resize).toHaveBeenCalledWith(200, 60);
    expect(ptyB.resize).toHaveBeenCalledWith(200, 60);
  });

  it("resize on unknown peer is a no-op (no throw)", () => {
    const { pool } = buildPool();
    expect(() => pool.resize("ghost", 80, 24)).not.toThrow();
  });

  it("resize on exited peer is a no-op", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");
    pty.simulateExit(0, "");
    expect(() => pool.resize("peer-a", 80, 24)).not.toThrow();
    // resize should not have been called after exit
    expect(pty.resize).not.toHaveBeenCalled();
  });
});

// ── write ─────────────────────────────────────────────────────────────────────

describe("write", () => {
  it("calls write() on the mock PTY", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");
    pool.write("peer-a", "hello\r");
    expect(pty.write).toHaveBeenCalledWith("hello\r");
  });

  it("write on unknown peer is a no-op", () => {
    const { pool } = buildPool();
    expect(() => pool.write("ghost", "data")).not.toThrow();
  });

  it("write on exited peer is a no-op", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");
    pty.simulateExit(0, "");
    expect(() => pool.write("peer-a", "data")).not.toThrow();
    expect(pty.write).not.toHaveBeenCalled();
  });
});

// ── kill ──────────────────────────────────────────────────────────────────────

describe("kill", () => {
  it("calls kill('SIGTERM') on the mock PTY", async () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");

    const killPromise = pool.kill("peer-a", 100);
    // Simulate the PTY exiting after receiving SIGTERM.
    pty.simulateExit(0, "SIGTERM");
    await killPromise;

    expect(pty.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("transitions state to 'exiting' while kill is in progress", async () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");

    // Start kill but don't resolve yet.
    const killPromise = pool.kill("peer-a", 5000);
    // State should be exiting.
    expect(pool.getStatus("peer-a")?.state).toBe("exiting");

    // Resolve it.
    pty.simulateExit(0, "");
    await killPromise;
  });

  it("kill on unknown peer resolves immediately", async () => {
    const { pool } = buildPool();
    await expect(pool.kill("ghost")).resolves.toBeUndefined();
  });

  it("kill on already-exited peer resolves immediately", async () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");
    pty.simulateExit(0, "");
    await expect(pool.kill("peer-a")).resolves.toBeUndefined();
  });

  it("state is 'exited' after kill completes", async () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");
    const killPromise = pool.kill("peer-a", 100);
    pty.simulateExit(0, "");
    await killPromise;
    expect(pool.getStatus("peer-a")?.state).toBe("exited");
  });
});
