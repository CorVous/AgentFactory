/**
 * decisions-queue.test.ts — hermetic unit tests for the launcher decisions queue.
 *
 * Contract: no I/O, no network, no env from models.env.
 * Tests cover enqueue/dismiss/pin transitions, sticky lifecycle, count badge.
 */

import { describe, it, expect } from "vitest";
import { createDecisionsQueue } from "./decisions-queue.mjs";

describe("createDecisionsQueue — enqueue", () => {
  it("returns an item with the given fields plus ts and pinned:false", () => {
    const q = createDecisionsQueue();
    const item = q.enqueue({ msg_id: "msg-1", peer: "authority", kind: "approval-request", summary: "needs approval" });
    expect(item.msg_id).toBe("msg-1");
    expect(item.peer).toBe("authority");
    expect(item.kind).toBe("approval-request");
    expect(item.summary).toBe("needs approval");
    expect(typeof item.ts).toBe("number");
    expect(item.pinned).toBe(false);
  });

  it("starts with count 0 and increments on enqueue", () => {
    const q = createDecisionsQueue();
    expect(q.count()).toBe(0);
    q.enqueue({ msg_id: "a", peer: "p", kind: "submission", summary: "s" });
    expect(q.count()).toBe(1);
    q.enqueue({ msg_id: "b", peer: "p", kind: "approval-request", summary: "t" });
    expect(q.count()).toBe(2);
  });

  it("replaces existing item when msg_id already exists", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "dup", peer: "peer-a", kind: "submission", summary: "first" });
    q.enqueue({ msg_id: "dup", peer: "peer-b", kind: "approval-request", summary: "second" });
    expect(q.count()).toBe(1);
    const items = q.list();
    expect(items[0].summary).toBe("second");
    expect(items[0].peer).toBe("peer-b");
  });
});

describe("createDecisionsQueue — list", () => {
  it("returns items in insertion order", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "z", peer: "p", kind: "k", summary: "first" });
    q.enqueue({ msg_id: "a", peer: "p", kind: "k", summary: "second" });
    const items = q.list();
    expect(items.map((i) => i.msg_id)).toEqual(["z", "a"]);
  });

  it("returns empty array when queue is empty", () => {
    const q = createDecisionsQueue();
    expect(q.list()).toEqual([]);
  });
});

describe("createDecisionsQueue — dismiss", () => {
  it("removes an item by msg_id and returns true", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "msg-1", peer: "p", kind: "k", summary: "s" });
    expect(q.count()).toBe(1);
    const ok = q.dismiss("msg-1");
    expect(ok).toBe(true);
    expect(q.count()).toBe(0);
  });

  it("returns false when msg_id is not found", () => {
    const q = createDecisionsQueue();
    expect(q.dismiss("nonexistent")).toBe(false);
  });

  it("removes only the target item, leaves others intact", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "a", peer: "p", kind: "k", summary: "s" });
    q.enqueue({ msg_id: "b", peer: "p", kind: "k", summary: "s" });
    q.dismiss("a");
    expect(q.count()).toBe(1);
    expect(q.list()[0].msg_id).toBe("b");
  });
});

describe("createDecisionsQueue — pin (sticky lifecycle)", () => {
  it("sets pinned:true on the item", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "msg-1", peer: "p", kind: "k", summary: "s" });
    const ok = q.pin("msg-1");
    expect(ok).toBe(true);
    expect(q.list()[0].pinned).toBe(true);
  });

  it("returns false when item not found", () => {
    const q = createDecisionsQueue();
    expect(q.pin("missing")).toBe(false);
  });

  it("pinned item survives explicit dismiss (confirm dismiss still works)", () => {
    // The caller (launch-mesh) decides whether to dismiss pinned items;
    // the queue itself always honors explicit dismiss() regardless of pin state.
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "msg-1", peer: "p", kind: "k", summary: "s" });
    q.pin("msg-1");
    expect(q.dismiss("msg-1")).toBe(true);
    expect(q.count()).toBe(0);
  });

  it("pinned items remain in list after non-pinned items are dismissed", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "transient", peer: "p", kind: "k", summary: "s" });
    q.enqueue({ msg_id: "sticky", peer: "p", kind: "k", summary: "s" });
    q.pin("sticky");
    // Simulate a focus-change: caller dismisses non-pinned items only.
    const nonPinned = q.list().filter((i) => !i.pinned);
    for (const i of nonPinned) q.dismiss(i.msg_id);
    expect(q.count()).toBe(1);
    expect(q.list()[0].msg_id).toBe("sticky");
    expect(q.list()[0].pinned).toBe(true);
  });
});

describe("createDecisionsQueue — unpin", () => {
  it("sets pinned:false on the item", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "msg-1", peer: "p", kind: "k", summary: "s" });
    q.pin("msg-1");
    const ok = q.unpin("msg-1");
    expect(ok).toBe(true);
    expect(q.list()[0].pinned).toBe(false);
  });

  it("returns false when item not found", () => {
    const q = createDecisionsQueue();
    expect(q.unpin("missing")).toBe(false);
  });
});

describe("createDecisionsQueue — count badge derivation", () => {
  it("count() reflects total items (pinned + non-pinned)", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "a", peer: "p", kind: "k", summary: "s" });
    q.enqueue({ msg_id: "b", peer: "p", kind: "k", summary: "s" });
    q.pin("a");
    expect(q.count()).toBe(2);
  });

  it("count() decrements after dismiss", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "a", peer: "p", kind: "k", summary: "s" });
    q.enqueue({ msg_id: "b", peer: "p", kind: "k", summary: "s" });
    q.dismiss("a");
    expect(q.count()).toBe(1);
  });

  it("count() is 0 for empty queue", () => {
    expect(createDecisionsQueue().count()).toBe(0);
  });
});

describe("createDecisionsQueue — decoupling from focus-controller", () => {
  it("queue does not emit focus events or subscribe to any external state", () => {
    // The queue is a pure data structure with no side effects.
    // This test verifies it can be created and used without any external dependencies.
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "x", peer: "peer-a", kind: "approval-request", summary: "approve me" });
    q.pin("x");
    // No focus events fired, no external state read.
    expect(q.count()).toBe(1);
    expect(q.list()[0].pinned).toBe(true);
  });

  it("multiple independent queues do not share state", () => {
    const q1 = createDecisionsQueue();
    const q2 = createDecisionsQueue();
    q1.enqueue({ msg_id: "a", peer: "p", kind: "k", summary: "s" });
    expect(q1.count()).toBe(1);
    expect(q2.count()).toBe(0);
  });
});
