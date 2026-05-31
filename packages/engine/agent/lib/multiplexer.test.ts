/**
 * multiplexer.test.ts — engine-lib hermetic unit tests for Multiplexer.
 * Near-copy of scripts/_lib/multiplexer.test.ts, repointed at ../lib/multiplexer.mjs.
 *
 * Contract: no real PTY, no real terminal, no network.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
// @ts-ignore — no TS declarations for .mjs; same pattern as other engine-lib test files
import { createMultiplexer, Multiplexer } from "./multiplexer.mjs";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOutputStream() {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => { chunks.push(chunk); return true; },
    get output() { return chunks.join(""); },
    get calls() { return chunks.length; },
    reset() { chunks.length = 0; },
  };
}

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

// ── createMultiplexer ────────────────────────────────────────────────────────

describe("createMultiplexer", () => {
  it("returns a Multiplexer instance", () => {
    const out = makeOutputStream();
    const mux = createMultiplexer({ out: out as any });
    expect(mux).toBeInstanceOf(Multiplexer);
  });

  it("getFocus() starts as null", () => {
    const out = makeOutputStream();
    const mux = createMultiplexer({ out: out as any });
    expect(mux.getFocus()).toBeNull();
  });
});

// ── setFocus ──────────────────────────────────────────────────────────────────

describe("setFocus", () => {
  it("updates getFocus() to the new peer", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    pool.addBuffer("peer-a", () => "peer-a output");

    const mux = createMultiplexer({ out: out as any });
    mux.attachPool(pool as any);
    mux.setFocus("peer-a");

    expect(mux.getFocus()).toBe("peer-a");
  });

  it("setting focus to null clears the focused peer", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    pool.addBuffer("peer-a", () => "peer-a output");

    const mux = createMultiplexer({ out: out as any });
    mux.attachPool(pool as any);
    mux.setFocus("peer-a");
    mux.setFocus(null);

    expect(mux.getFocus()).toBeNull();
  });
});

// ── attachPool ────────────────────────────────────────────────────────────────

describe("attachPool", () => {
  it("writes output data to the stream when the focused peer emits data", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();
    pool.addBuffer("peer-a", () => "rendered output");

    const mux = createMultiplexer({ out: out as any });
    mux.attachPool(pool as any);
    mux.setFocus("peer-a");

    out.reset(); // clear any output from setFocus

    pool.simulateOutput("peer-a", "new data from pty");

    // The multiplexer passes through raw PTY chunks to out.write on output events.
    expect(out.output).toContain("new data from pty");
  });

  it("does not repaint on output from a non-focused peer", () => {
    const out = makeOutputStream();
    const pool = makeFakePool();

    let paintCallCount = 0;
    pool.addBuffer("peer-a", () => {
      paintCallCount++;
      return "peer-a output";
    });
    pool.addBuffer("peer-b", () => "peer-b output");

    const mux = createMultiplexer({ out: out as any });
    mux.attachPool(pool as any);
    mux.setFocus("peer-a");

    out.reset();
    paintCallCount = 0;

    // Output from non-focused peer
    pool.simulateOutput("peer-b", "some data from b");

    expect(paintCallCount).toBe(0);
  });
});
