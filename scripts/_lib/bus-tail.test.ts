/**
 * bus-tail.test.ts — hermetic unit tests for bus-tail overlay state and rendering.
 *
 * Contract: no I/O, no network, no env from models.env.
 */

import { describe, it, expect } from "vitest";
import {
  BusTailBuffer,
  createBusTailBuffer,
  normaliseFilter,
  renderBusTailOverlay,
  stripAnsi,
  TAIL_BUFFER_MAX,
} from "./bus-tail.mjs";

// ── normaliseFilter ────────────────────────────────────────────────────────────

describe("normaliseFilter", () => {
  it("returns undefined for undefined input", () => {
    expect(normaliseFilter(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normaliseFilter("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(normaliseFilter("   ")).toBeUndefined();
  });

  it("normalises 'submissions' to 'submission'", () => {
    expect(normaliseFilter("submissions")).toBe("submission");
  });

  it("normalises 'messages' to 'message'", () => {
    expect(normaliseFilter("messages")).toBe("message");
  });

  it("normalises to lowercase", () => {
    expect(normaliseFilter("SUBMISSION")).toBe("submission");
    expect(normaliseFilter("Approval-Request")).toBe("approval-request");
  });

  it("passes through unknown kinds unchanged (lowercased)", () => {
    expect(normaliseFilter("approval-request")).toBe("approval-request");
    expect(normaliseFilter("revision-requested")).toBe("revision-requested");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normaliseFilter("  message  ")).toBe("message");
  });
});

// ── BusTailBuffer ──────────────────────────────────────────────────────────────

describe("BusTailBuffer — construction", () => {
  it("starts empty", () => {
    const buf = createBusTailBuffer();
    expect(buf.size()).toBe(0);
    expect(buf.getEntries(undefined)).toHaveLength(0);
  });
});

describe("BusTailBuffer — push", () => {
  it("appends entries", () => {
    const buf = createBusTailBuffer();
    buf.push({ sender: "a", recipient: "b", envKind: "message", body: "hi", ts: 1000 });
    expect(buf.size()).toBe(1);
  });

  it("FIFO-drops oldest when over cap", () => {
    const buf = createBusTailBuffer();
    for (let i = 0; i < TAIL_BUFFER_MAX + 5; i++) {
      buf.push({ sender: "a", recipient: "b", envKind: "message", body: `msg-${i}`, ts: i });
    }
    expect(buf.size()).toBe(TAIL_BUFFER_MAX);
    // Oldest 5 entries should be gone; first entry now starts at index 5
    const entries = buf.getEntries(undefined);
    expect(entries[0].body).toBe("msg-5");
    expect(entries[TAIL_BUFFER_MAX - 1].body).toBe(`msg-${TAIL_BUFFER_MAX + 4}`);
  });

  it("exactly at cap does not drop", () => {
    const buf = createBusTailBuffer();
    for (let i = 0; i < TAIL_BUFFER_MAX; i++) {
      buf.push({ sender: "a", recipient: "b", envKind: "message", body: `msg-${i}`, ts: i });
    }
    expect(buf.size()).toBe(TAIL_BUFFER_MAX);
  });
});

describe("BusTailBuffer — getEntries", () => {
  it("returns all entries when filter is undefined", () => {
    const buf = createBusTailBuffer();
    buf.push({ sender: "a", recipient: "b", envKind: "message", body: "hello", ts: 1 });
    buf.push({ sender: "c", recipient: "d", envKind: "submission", body: "file", ts: 2 });
    const all = buf.getEntries(undefined);
    expect(all).toHaveLength(2);
  });

  it("filters by exact envKind", () => {
    const buf = createBusTailBuffer();
    buf.push({ sender: "a", recipient: "b", envKind: "message", body: "hello", ts: 1 });
    buf.push({ sender: "c", recipient: "d", envKind: "submission", body: "file", ts: 2 });
    const messages = buf.getEntries("message");
    expect(messages).toHaveLength(1);
    expect(messages[0].envKind).toBe("message");
  });

  it("normalises filter alias 'messages' → 'message'", () => {
    const buf = createBusTailBuffer();
    buf.push({ sender: "a", recipient: "b", envKind: "message", body: "hello", ts: 1 });
    buf.push({ sender: "c", recipient: "d", envKind: "submission", body: "file", ts: 2 });
    const messages = buf.getEntries("messages");
    expect(messages).toHaveLength(1);
    expect(messages[0].envKind).toBe("message");
  });

  it("normalises filter alias 'submissions' → 'submission'", () => {
    const buf = createBusTailBuffer();
    buf.push({ sender: "a", recipient: "b", envKind: "message", body: "hello", ts: 1 });
    buf.push({ sender: "c", recipient: "d", envKind: "submission", body: "file", ts: 2 });
    const subs = buf.getEntries("submissions");
    expect(subs).toHaveLength(1);
    expect(subs[0].envKind).toBe("submission");
  });

  it("returns a copy, not the internal array", () => {
    const buf = createBusTailBuffer();
    buf.push({ sender: "a", recipient: "b", envKind: "message", body: "hello", ts: 1 });
    const entries = buf.getEntries(undefined);
    entries.push({ sender: "x", recipient: "y", envKind: "message", body: "extra", ts: 2 });
    expect(buf.size()).toBe(1); // internal array unchanged
  });
});

describe("BusTailBuffer — clear", () => {
  it("empties the buffer", () => {
    const buf = createBusTailBuffer();
    buf.push({ sender: "a", recipient: "b", envKind: "message", body: "hello", ts: 1 });
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.getEntries(undefined)).toHaveLength(0);
  });
});

// ── renderBusTailOverlay ───────────────────────────────────────────────────────

describe("renderBusTailOverlay — header", () => {
  it("includes 'Bus Tail' in header", () => {
    const output = renderBusTailOverlay({ entries: [], active: false });
    expect(stripAnsi(output)).toContain("Bus Tail");
  });

  it("shows active status when on", () => {
    const output = renderBusTailOverlay({ entries: [], active: true });
    expect(stripAnsi(output)).toContain("active");
  });

  it("shows off status when inactive", () => {
    const output = renderBusTailOverlay({ entries: [], active: false });
    expect(stripAnsi(output)).toContain("off");
  });

  it("includes filter in header when provided", () => {
    const output = renderBusTailOverlay({ entries: [], active: true, filter: "message" });
    expect(stripAnsi(output)).toContain("message");
  });

  it("shows envelope count", () => {
    const entries = [
      { sender: "a", recipient: "b", envKind: "message", body: "hi", ts: 1 },
      { sender: "c", recipient: "d", envKind: "submission", body: "f", ts: 2 },
    ];
    const output = renderBusTailOverlay({ entries, active: true });
    expect(stripAnsi(output)).toContain("2 envelopes");
  });
});

describe("renderBusTailOverlay — inactive with no entries", () => {
  it("shows usage hint when inactive and empty", () => {
    const output = renderBusTailOverlay({ entries: [], active: false });
    expect(stripAnsi(output)).toContain("/tail");
  });
});

describe("renderBusTailOverlay — active with no entries", () => {
  it("shows 'no envelopes yet' when active and empty", () => {
    const output = renderBusTailOverlay({ entries: [], active: true });
    expect(stripAnsi(output)).toContain("no envelopes yet");
  });
});

describe("renderBusTailOverlay — entry rows", () => {
  it("shows sender → recipient", () => {
    const entries = [
      { sender: "peer-a", recipient: "peer-b", envKind: "message", body: "hello", ts: Date.now() },
    ];
    const output = renderBusTailOverlay({ entries, active: true });
    const plain = stripAnsi(output);
    expect(plain).toContain("peer-a");
    expect(plain).toContain("peer-b");
  });

  it("shows envelope kind", () => {
    const entries = [
      { sender: "a", recipient: "b", envKind: "submission", body: "file", ts: Date.now() },
    ];
    const output = renderBusTailOverlay({ entries, active: true });
    expect(stripAnsi(output)).toContain("submission");
  });

  it("shows body", () => {
    const entries = [
      { sender: "a", recipient: "b", envKind: "message", body: "hello world", ts: Date.now() },
    ];
    const output = renderBusTailOverlay({ entries, active: true });
    expect(stripAnsi(output)).toContain("hello world");
  });

  it("truncates long sender names to 12 chars", () => {
    const entries = [
      {
        sender: "a-very-long-peer-name",
        recipient: "b",
        envKind: "message",
        body: "hi",
        ts: Date.now(),
      },
    ];
    const output = stripAnsi(renderBusTailOverlay({ entries, active: true }));
    // "a-very-long-peer-name" is 21 chars → should be truncated to 12 + "…"
    expect(output).not.toContain("a-very-long-peer-name");
    expect(output).toContain("a-very-long…");
  });

  it("truncates long body to 30 chars with ellipsis", () => {
    const longBody = "a".repeat(40);
    const entries = [
      { sender: "a", recipient: "b", envKind: "message", body: longBody, ts: Date.now() },
    ];
    const output = stripAnsi(renderBusTailOverlay({ entries, active: true }));
    expect(output).not.toContain(longBody);
    expect(output).toContain("…");
  });

  it("shows only the most recent maxRows entries", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      sender: "a",
      recipient: "b",
      envKind: "message",
      body: `msg-${i}`,
      ts: i,
    }));
    // Default maxRows is 10
    const output = stripAnsi(renderBusTailOverlay({ entries, active: true }));
    expect(output).toContain("msg-19");  // newest visible
    expect(output).not.toContain("msg-0"); // oldest not visible
  });

  it("respects custom maxRows", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      sender: "a",
      recipient: "b",
      envKind: "message",
      body: `msg-${i}`,
      ts: i,
    }));
    const output = stripAnsi(renderBusTailOverlay({ entries, active: true, maxRows: 2 }));
    expect(output).toContain("msg-4"); // newest
    expect(output).not.toContain("msg-0"); // older than maxRows
  });
});

describe("renderBusTailOverlay — output format", () => {
  it("is a multi-line string terminated with newline", () => {
    const output = renderBusTailOverlay({ entries: [], active: false });
    expect(output.endsWith("\n")).toBe(true);
    expect(output.split("\n").length).toBeGreaterThan(1);
  });

  it("is deterministic for the same input", () => {
    const entries = [
      { sender: "a", recipient: "b", envKind: "message", body: "hi", ts: 1000 },
    ];
    const opts = { entries, active: true, filter: "message" };
    expect(renderBusTailOverlay(opts)).toBe(renderBusTailOverlay(opts));
  });
});

// ── TAIL_BUFFER_MAX ────────────────────────────────────────────────────────────

describe("TAIL_BUFFER_MAX", () => {
  it("is 200", () => {
    expect(TAIL_BUFFER_MAX).toBe(200);
  });
});
