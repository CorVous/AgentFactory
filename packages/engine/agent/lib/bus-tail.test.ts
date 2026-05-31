/**
 * bus-tail.test.ts — engine-lib hermetic unit tests for bus-tail overlay.
 * Near-copy of scripts/_lib/bus-tail.test.ts, repointed at ../lib/bus-tail.mjs.
 *
 * Contract: no I/O, no network, no env from models.env.
 */

import { describe, it, expect } from "vitest";
// @ts-ignore — no TS declarations for .mjs; same pattern as other engine-lib test files
import { BusTailBuffer, createBusTailBuffer, normaliseFilter, renderBusTailOverlay, stripAnsi, TAIL_BUFFER_MAX } from "./bus-tail.mjs";

// ── normaliseFilter ────────────────────────────────────────────────────────────

describe("normaliseFilter", () => {
  it("returns undefined for undefined input", () => {
    expect(normaliseFilter(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normaliseFilter("")).toBeUndefined();
  });

  it("normalises 'submissions' to 'submission'", () => {
    expect(normaliseFilter("submissions")).toBe("submission");
  });

  it("normalises 'messages' to 'message'", () => {
    expect(normaliseFilter("messages")).toBe("message");
  });

  it("normalises to lowercase", () => {
    expect(normaliseFilter("SUBMISSION")).toBe("submission");
  });

  it("passes through unknown kinds (lowercased)", () => {
    expect(normaliseFilter("approval-request")).toBe("approval-request");
  });
});

// ── BusTailBuffer ─────────────────────────────────────────────────────────────

describe("BusTailBuffer", () => {
  it("starts empty", () => {
    const buf = createBusTailBuffer();
    expect(buf.getEntries()).toEqual([]);
  });

  it("push adds entries", () => {
    const buf = createBusTailBuffer();
    buf.push({ ts: 1000, sender: "a", recipient: "b", envKind: "message", body: "hi" });
    expect(buf.getEntries()).toHaveLength(1);
  });

  it("clear empties the buffer", () => {
    const buf = createBusTailBuffer();
    buf.push({ ts: 1000, sender: "a", recipient: "b", envKind: "message", body: "hi" });
    buf.clear();
    expect(buf.getEntries()).toHaveLength(0);
  });

  it(`caps at TAIL_BUFFER_MAX (${TAIL_BUFFER_MAX}) entries with FIFO eviction`, () => {
    const buf = createBusTailBuffer();
    for (let i = 0; i < TAIL_BUFFER_MAX + 5; i++) {
      buf.push({ ts: i, sender: "a", recipient: "b", envKind: "message", body: `msg-${i}` });
    }
    const entries = buf.getEntries();
    expect(entries).toHaveLength(TAIL_BUFFER_MAX);
    // First 5 should have been evicted; entry 0 should be msg-5
    expect(entries[0].body).toBe("msg-5");
  });

  it("getEntries with filter returns only matching entries", () => {
    const buf = createBusTailBuffer();
    buf.push({ ts: 1, sender: "a", recipient: "b", envKind: "message", body: "m" });
    buf.push({ ts: 2, sender: "a", recipient: "b", envKind: "submission", body: "s" });
    const filtered = buf.getEntries("message");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].envKind).toBe("message");
  });
});

// ── stripAnsi ─────────────────────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("removes ANSI escape sequences from a string", () => {
    const ansi = "\x1b[1mBold\x1b[0m and \x1b[32mgreen\x1b[0m";
    expect(stripAnsi(ansi)).toBe("Bold and green");
  });

  it("returns unchanged string with no ANSI codes", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

// ── renderBusTailOverlay ──────────────────────────────────────────────────────

describe("renderBusTailOverlay", () => {
  it("returns a non-empty string with a 'Bus Tail' header even when not active", () => {
    const result = renderBusTailOverlay({ entries: [], active: false });
    // renderBusTailOverlay always renders a header; check it contains expected text
    const plain = stripAnsi(result);
    expect(plain).toContain("Bus Tail");
  });

  it("returns a non-empty string with entries when active", () => {
    const entries = [
      { ts: Date.now(), sender: "peer-a", recipient: "peer-b", envKind: "message", body: "hello" },
    ];
    const result = renderBusTailOverlay({ entries, active: true });
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes sender and recipient in the rendered output (stripped of ANSI)", () => {
    const entries = [
      { ts: Date.now(), sender: "peer-alpha", recipient: "peer-beta", envKind: "message", body: "test" },
    ];
    const result = renderBusTailOverlay({ entries, active: true });
    const plain = stripAnsi(result);
    expect(plain).toContain("peer-alpha");
    expect(plain).toContain("peer-beta");
  });
});
