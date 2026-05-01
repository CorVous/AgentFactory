/**
 * multiplexer.test.ts — hermetic unit tests for Multiplexer.
 *
 * Contract:
 *   - No real PTY, no real terminal, no network.
 *   - The Multiplexer is exercised via a fake PtyPool (EventEmitter) and
 *     a writable stream stub that captures written ANSI output.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { createMultiplexer, Multiplexer } from "./multiplexer.mjs";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * A writable stream stub that collects everything written to it.
 */
function makeOutputStream() {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => { chunks.push(chunk); return true; },
    get output() { return chunks.join(""); },
    get calls() { return chunks.length; },
    reset() { chunks.length = 0; },
  };
}

/**
 * A fake PtyPool that exposes just enough surface to drive the Multiplexer:
 *   - extends EventEmitter (so .on("output", ...) works)
 *   - getBuffer(name): returns a fake VirtualBuffer with a controllable paint()
 */
function makeFakePool() {
  const ee = new EventEmitter() as EventEmitter & {
    getBuffer: (name: string) => { paint: () => string } | undefined;
    _buffers: Map<string, { paint: () => string }>;
    addBuffer: (name: string, paintFn: () => string) => void;
    simulateOutput: (name: string, data: string) => void;
  };

  ee._buffers = new Map();
  ee.getBuffer = (name: string) => ee._buffers.get(name);
  ee.addBuffer = (name: string, paintFn: () => string) => {
    ee._buffers.set(name, { paint: paintFn });
  };
  ee.simulateOutput = (name: string, data: string) => {
    ee.emit("output", name, data);
  };

  return ee;
}

// ── setFocus / getFocus ───────────────────────────────────────────────────────

describe("setFocus / getFocus", () => {
  it("getFocus() starts as null", () => {
    const mux = createMultiplexer();
    expect(mux.getFocus()).toBeNull();
  });

  it("setFocus sets the focused peer", () => {
    const mux = createMultiplexer();
    mux.setFocus("peer-a");
    expect(mux.getFocus()).toBe("peer-a");
  });

  it("setFocus to null clears focus", () => {
    const mux = createMultiplexer();
    mux.setFocus("peer-a");
    mux.setFocus(null);
    expect(mux.getFocus()).toBeNull();
  });

  it("setFocus emits 'focus-changed' event when focus changes", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    const mux = createMultiplexer({ out });
    mux.attachPool(pool as any);

    const events: (string | null)[] = [];
    mux.on("focus-changed", (name) => events.push(name));

    mux.setFocus("peer-a");
    mux.setFocus("peer-b");

    expect(events).toEqual(["peer-a", "peer-b"]);
  });

  it("setFocus does not emit 'focus-changed' when focus is unchanged", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    const mux = createMultiplexer({ out });
    mux.attachPool(pool as any);

    const events: (string | null)[] = [];
    mux.on("focus-changed", (name) => events.push(name));

    mux.setFocus("peer-a");
    mux.setFocus("peer-a"); // same peer, no duplicate event

    expect(events).toHaveLength(1);
  });
});

// ── paint ─────────────────────────────────────────────────────────────────────

describe("paint", () => {
  it("paint() writes the focused buffer's ANSI output to the stream", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    pool.addBuffer("peer-a", () => "ANSI-CONTENT-A");

    const mux = createMultiplexer({ out });
    mux.attachPool(pool as any);
    mux.setFocus("peer-a");
    out.reset(); // setFocus triggers a paint; reset for the explicit call

    mux.paint();
    expect(out.output).toBe("ANSI-CONTENT-A");
  });

  it("paint() is a no-op when focus is null", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    pool.addBuffer("peer-a", () => "ANSI-CONTENT-A");

    const mux = createMultiplexer({ out });
    mux.attachPool(pool as any);
    // do not call setFocus
    mux.paint();
    expect(out.calls).toBe(0);
  });

  it("paint() is a no-op when no pool is attached", () => {
    const out = makeOutputStream();
    const mux = createMultiplexer({ out });
    mux.setFocus("peer-a"); // setFocus triggers _repaint which is no-op without pool
    expect(out.calls).toBe(0);
    mux.paint();
    expect(out.calls).toBe(0);
  });

  it("paint() is a no-op when focused peer has no buffer", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    // no buffer added for "ghost"
    const mux = createMultiplexer({ out });
    mux.attachPool(pool as any);
    mux.setFocus("ghost");
    out.reset();
    mux.paint();
    expect(out.calls).toBe(0);
  });
});

// ── attachPool + output events ────────────────────────────────────────────────

describe("attachPool", () => {
  it("repaints the focused buffer when the focused peer emits output", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    let content = "first";
    pool.addBuffer("peer-a", () => content);

    const mux = createMultiplexer({ out });
    mux.attachPool(pool as any);
    mux.setFocus("peer-a");
    out.reset();

    content = "second";
    pool.simulateOutput("peer-a", "chunk");
    expect(out.output).toBe("second");
  });

  it("does not repaint when a non-focused peer emits output", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    pool.addBuffer("peer-a", () => "A-CONTENT");
    pool.addBuffer("peer-b", () => "B-CONTENT");

    const mux = createMultiplexer({ out });
    mux.attachPool(pool as any);
    mux.setFocus("peer-a");
    out.reset();

    pool.simulateOutput("peer-b", "some data");
    expect(out.calls).toBe(0);
  });

  it("repaints when focus switches to a peer that then emits output", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    pool.addBuffer("peer-a", () => "A");
    pool.addBuffer("peer-b", () => "B");

    const mux = createMultiplexer({ out });
    mux.attachPool(pool as any);
    mux.setFocus("peer-a");
    out.reset();

    mux.setFocus("peer-b");
    out.reset();

    pool.simulateOutput("peer-b", "chunk");
    expect(out.output).toBe("B");
  });
});

// ── setFocus is the slice-3 seam ─────────────────────────────────────────────

describe("setFocus seam for slice-3 focus switching", () => {
  it("switching focus repaints with the new peer's buffer immediately", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    pool.addBuffer("peer-a", () => "BUFFER-A");
    pool.addBuffer("peer-b", () => "BUFFER-B");

    const mux = createMultiplexer({ out });
    mux.attachPool(pool as any);

    mux.setFocus("peer-a");
    out.reset();
    mux.setFocus("peer-b");
    expect(out.output).toBe("BUFFER-B");
  });
});

// ── attachResizeHandler ───────────────────────────────────────────────────────

describe("attachResizeHandler", () => {
  it("SIGWINCH calls resizeAll on the pool", () => {
    const pool = makeFakePool() as any;
    pool.resizeAll = vi.fn();

    const mux = createMultiplexer({
      getTermSize: () => ({ cols: 160, rows: 50 }),
    });
    mux.attachResizeHandler(pool);

    process.emit("SIGWINCH");

    expect(pool.resizeAll).toHaveBeenCalledWith(160, 50);

    // Cleanup: detach so we don't leave a SIGWINCH listener between tests.
    mux.detach();
  });
});

// ── detach ────────────────────────────────────────────────────────────────────

describe("detach", () => {
  it("detach() stops pool output events from triggering repaints", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    pool.addBuffer("peer-a", () => "X");

    const mux = createMultiplexer({ out });
    mux.attachPool(pool as any);
    mux.setFocus("peer-a");
    out.reset();

    mux.detach();
    pool.simulateOutput("peer-a", "chunk");
    expect(out.calls).toBe(0);
  });

  it("detach() removes the SIGWINCH handler so pool.resizeAll is not called", () => {
    const pool = makeFakePool() as any;
    pool.resizeAll = vi.fn();

    const mux = createMultiplexer({
      getTermSize: () => ({ cols: 80, rows: 24 }),
    });
    mux.attachResizeHandler(pool);
    mux.detach();

    process.emit("SIGWINCH");
    expect(pool.resizeAll).not.toHaveBeenCalled();
  });
});
