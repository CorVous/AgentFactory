/**
 * pty-pool.test.ts — engine-lib hermetic unit tests for PtyPool.
 * Near-copy of scripts/_lib/pty-pool.test.ts, repointed at ../lib/pty-pool.mjs.
 *
 * No real PTY allocation. The spawnFn is injected as a mock.
 */

import { describe, it, expect, vi } from "vitest";
// @ts-ignore — no TS declarations for .mjs; same pattern as other engine-lib test files
import { createPtyPool, PtyPool } from "./pty-pool.mjs";

// ── mock PTY factory ──────────────────────────────────────────────────────────

function makeMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((info: { exitCode: number; signal: string }) => void) | null = null;

  const pty = {
    onData: (cb: (data: string) => void) => { dataHandler = cb; },
    onExit: (cb: (info: { exitCode: number; signal: string }) => void) => { exitHandler = cb; },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    simulateData: (data: string) => dataHandler?.(data),
    simulateExit: (exitCode = 0, signal = "") => exitHandler?.({ exitCode, signal }),
  };
  return pty;
}

type MockPty = ReturnType<typeof makeMockPty>;

function buildPool() {
  const mockPtys = new Map<string, MockPty>();
  let spawnCallCount = 0;

  const spawnFn = (_cmd: string, _args: string[], _opts: Record<string, unknown>) => {
    const pty = makeMockPty();
    spawnCallCount++;
    mockPtys.set(`__spawn_${spawnCallCount}`, pty);
    return pty;
  };

  const pool = createPtyPool({ spawnFn });
  return { pool, mockPtys };
}

function spawnPeer(pool: PtyPool, mockPtys: Map<string, MockPty>, name: string) {
  const vb = pool.spawn({
    name,
    cmd: "/bin/pi",
    args: [],
    cols: 80,
    rows: 24,
  });
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

  it("does NOT fire 'crash' event when PTY exits cleanly (code=0, no signal)", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");

    const crashes: unknown[] = [];
    pool.on("crash", (ev: unknown) => crashes.push(ev));

    pty.simulateExit(0, "");

    expect(crashes).toHaveLength(0);
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
});

// ── write ─────────────────────────────────────────────────────────────────────

describe("write", () => {
  it("calls write() on the mock PTY", () => {
    const { pool, mockPtys } = buildPool();
    const { pty } = spawnPeer(pool, mockPtys, "peer-a");
    pool.write("peer-a", "input data");
    expect(pty.write).toHaveBeenCalledWith("input data");
  });

  it("write on unknown peer is a no-op (no throw)", () => {
    const { pool } = buildPool();
    expect(() => pool.write("ghost", "data")).not.toThrow();
  });
});
