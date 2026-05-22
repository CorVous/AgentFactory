/**
 * decisions-queue.test.ts — engine-lib hermetic unit tests for decisions queue.
 * Near-copy of scripts/_lib/decisions-queue.test.ts, repointed at ../lib/decisions-queue.mjs.
 *
 * Contract: no I/O, no network, no env from models.env.
 */

import { describe, it, expect } from "vitest";
// @ts-ignore — no TS declarations for .mjs; same pattern as other engine-lib test files
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
});

describe("createDecisionsQueue — list", () => {
  it("returns items in insertion order", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "z", peer: "p", kind: "k", summary: "first" });
    q.enqueue({ msg_id: "a", peer: "p", kind: "k", summary: "second" });
    const items = q.list();
    expect(items.map((i: any) => i.msg_id)).toEqual(["z", "a"]);
  });

  it("returns empty array when queue is empty", () => {
    const q = createDecisionsQueue();
    expect(q.list()).toEqual([]);
  });
});

describe("createDecisionsQueue — dismiss", () => {
  it("removes an item by msg_id and returns true", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "x", peer: "p", kind: "k", summary: "s" });
    const result = q.dismiss("x");
    expect(result).toBe(true);
    expect(q.count()).toBe(0);
  });

  it("returns false when msg_id is not found", () => {
    const q = createDecisionsQueue();
    expect(q.dismiss("nonexistent")).toBe(false);
  });
});

describe("createDecisionsQueue — pin / unpin", () => {
  it("pin sets item.pinned to true", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "p1", peer: "peer", kind: "k", summary: "s" });
    q.pin("p1");
    const items = q.list();
    expect(items[0].pinned).toBe(true);
  });

  it("unpin sets item.pinned to false", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "p1", peer: "peer", kind: "k", summary: "s" });
    q.pin("p1");
    q.unpin("p1");
    const items = q.list();
    expect(items[0].pinned).toBe(false);
  });

  it("pin on unknown msg_id returns false", () => {
    const q = createDecisionsQueue();
    expect(q.pin("ghost")).toBe(false);
  });
});

describe("createDecisionsQueue — count", () => {
  it("decrements on dismiss", () => {
    const q = createDecisionsQueue();
    q.enqueue({ msg_id: "a", peer: "p", kind: "k", summary: "s" });
    q.enqueue({ msg_id: "b", peer: "p", kind: "k", summary: "s" });
    q.dismiss("a");
    expect(q.count()).toBe(1);
  });
});
