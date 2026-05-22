// _lib/intercept.test.ts — hermetic unit tests for intercept routing logic.
//
// Contract: no I/O, no network, no env from models.env, no ctx.ui calls.
// The routing functions are pure; tests only check the route decision.

import { describe, it, expect } from "vitest";
import { routeEnvelope, isTopSupervisor, hasSupervisorInboundRail, batchDecision, createInterceptBatch } from "./intercept";

// ---------------------------------------------------------------------------
// routeEnvelope — "message" kind is always "llm"
// ---------------------------------------------------------------------------

describe('routeEnvelope — "message" kind', () => {
  it("returns llm when focused=false", () => {
    expect(routeEnvelope("message", false)).toBe("llm");
  });

  it("returns llm even when focused=true", () => {
    expect(routeEnvelope("message", true)).toBe("llm");
  });
});

// ---------------------------------------------------------------------------
// routeEnvelope — "approval-request" kind
// ---------------------------------------------------------------------------

describe('routeEnvelope — "approval-request" kind', () => {
  it("returns human when focused=true", () => {
    expect(routeEnvelope("approval-request", true)).toBe("human");
  });

  it("returns llm when focused=false", () => {
    expect(routeEnvelope("approval-request", false)).toBe("llm");
  });
});

// ---------------------------------------------------------------------------
// routeEnvelope — "submission" kind
// ---------------------------------------------------------------------------

describe('routeEnvelope — "submission" kind', () => {
  it("returns human when focused=true", () => {
    expect(routeEnvelope("submission", true)).toBe("human");
  });

  it("returns llm when focused=false", () => {
    expect(routeEnvelope("submission", false)).toBe("llm");
  });
});

// ---------------------------------------------------------------------------
// routeEnvelope — other kinds always "llm"
// ---------------------------------------------------------------------------

describe("routeEnvelope — other payload kinds", () => {
  it("returns llm for approval-result regardless of focus", () => {
    expect(routeEnvelope("approval-result", true)).toBe("llm");
    expect(routeEnvelope("approval-result", false)).toBe("llm");
  });

  it("returns llm for revision-requested regardless of focus", () => {
    expect(routeEnvelope("revision-requested", true)).toBe("llm");
    expect(routeEnvelope("revision-requested", false)).toBe("llm");
  });

  it("returns llm for unknown future kinds regardless of focus", () => {
    expect(routeEnvelope("some-future-kind", true)).toBe("llm");
    expect(routeEnvelope("some-future-kind", false)).toBe("llm");
  });
});

// ---------------------------------------------------------------------------
// isTopSupervisor — detects absence of a supervisor above this peer
// ---------------------------------------------------------------------------

describe("isTopSupervisor", () => {
  it("returns true when supervisor is undefined", () => {
    expect(isTopSupervisor(undefined)).toBe(true);
  });

  it("returns true when supervisor is empty string", () => {
    expect(isTopSupervisor("")).toBe(true);
  });

  it("returns true when supervisor is whitespace only", () => {
    expect(isTopSupervisor("   ")).toBe(true);
  });

  it("returns false when supervisor is a non-empty peer name", () => {
    expect(isTopSupervisor("lead-hare")).toBe(false);
  });

  it("returns false when supervisor is any non-empty string", () => {
    expect(isTopSupervisor("authority")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasSupervisorInboundRail — detects whether rail is active
// ---------------------------------------------------------------------------

describe("hasSupervisorInboundRail", () => {
  it("returns false when acceptedFrom is empty array", () => {
    expect(hasSupervisorInboundRail([])).toBe(false);
  });

  it("returns true when acceptedFrom has at least one peer", () => {
    expect(hasSupervisorInboundRail(["worker-a"])).toBe(true);
  });

  it("returns true when acceptedFrom has multiple peers", () => {
    expect(hasSupervisorInboundRail(["worker-a", "worker-b"])).toBe(true);
  });

  it("returns false when acceptedFrom is not an array (edge case)", () => {
    // The Habitat type enforces array, but this guard protects against
    // misconfigured state. Cast to any to test the defensive path.
    expect(hasSupervisorInboundRail(null as unknown as string[])).toBe(false);
    expect(hasSupervisorInboundRail(undefined as unknown as string[])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Focus-change semantics — demonstrate focus=false → focus=true → focus=false
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// batchDecision — pure delegation to routeEnvelope
// ---------------------------------------------------------------------------

describe("batchDecision", () => {
  it("returns collect for submission when focused=true", () => {
    expect(batchDecision("submission", true)).toBe("collect");
  });

  it("returns passthrough for submission when focused=false", () => {
    expect(batchDecision("submission", false)).toBe("passthrough");
  });

  it("returns collect for approval-request when focused=true", () => {
    expect(batchDecision("approval-request", true)).toBe("collect");
  });

  it("returns passthrough for approval-request when focused=false", () => {
    expect(batchDecision("approval-request", false)).toBe("passthrough");
  });

  it("returns passthrough for message regardless of focus (always LLM)", () => {
    expect(batchDecision("message", true)).toBe("passthrough");
    expect(batchDecision("message", false)).toBe("passthrough");
  });

  it("returns passthrough for approval-result regardless of focus", () => {
    expect(batchDecision("approval-result", true)).toBe("passthrough");
    expect(batchDecision("approval-result", false)).toBe("passthrough");
  });

  it("returns passthrough for revision-requested regardless of focus", () => {
    expect(batchDecision("revision-requested", true)).toBe("passthrough");
    expect(batchDecision("revision-requested", false)).toBe("passthrough");
  });

  it("returns passthrough for unknown future kinds regardless of focus", () => {
    expect(batchDecision("some-future-kind", true)).toBe("passthrough");
    expect(batchDecision("some-future-kind", false)).toBe("passthrough");
  });
});

// ---------------------------------------------------------------------------
// createInterceptBatch — stateful queue
// ---------------------------------------------------------------------------

describe("createInterceptBatch", () => {
  it("starts with size 0 and empty peek", () => {
    const batch = createInterceptBatch<{ kind: string }>();
    expect(batch.size()).toBe(0);
    expect(batch.peek()).toEqual([]);
  });

  it("collect adds envelopes and size increments", () => {
    const batch = createInterceptBatch<{ kind: string }>();
    batch.collect({ kind: "submission" });
    expect(batch.size()).toBe(1);
    batch.collect({ kind: "approval-request" });
    expect(batch.size()).toBe(2);
  });

  it("peek returns a copy without clearing", () => {
    const batch = createInterceptBatch<{ kind: string }>();
    batch.collect({ kind: "submission" });
    const first = batch.peek();
    const second = batch.peek();
    expect(first).toEqual([{ kind: "submission" }]);
    expect(second).toEqual([{ kind: "submission" }]);
    expect(batch.size()).toBe(1); // still 1 after two peeks
  });

  it("peek returns a copy (mutation does not affect internal queue)", () => {
    const batch = createInterceptBatch<{ kind: string }>();
    batch.collect({ kind: "submission" });
    const copy = batch.peek();
    copy.push({ kind: "intruder" });
    expect(batch.size()).toBe(1); // internal queue unchanged
  });

  it("flush returns all items and clears the queue", () => {
    const batch = createInterceptBatch<{ kind: string }>();
    batch.collect({ kind: "submission" });
    batch.collect({ kind: "approval-request" });
    const items = batch.flush();
    expect(items).toEqual([{ kind: "submission" }, { kind: "approval-request" }]);
    expect(batch.size()).toBe(0);
    expect(batch.peek()).toEqual([]);
  });

  it("flush on empty batch returns []", () => {
    const batch = createInterceptBatch<{ kind: string }>();
    expect(batch.flush()).toEqual([]);
  });

  it("multiple collects then flush returns items in insertion order", () => {
    const batch = createInterceptBatch<{ kind: string; id: number }>();
    batch.collect({ kind: "submission", id: 1 });
    batch.collect({ kind: "submission", id: 2 });
    batch.collect({ kind: "submission", id: 3 });
    const items = batch.flush();
    expect(items.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("flush can be called repeatedly; only first call has items", () => {
    const batch = createInterceptBatch<{ kind: string }>();
    batch.collect({ kind: "submission" });
    const first = batch.flush();
    const second = batch.flush();
    expect(first.length).toBe(1);
    expect(second.length).toBe(0);
  });

  it("collect after flush adds to a fresh queue", () => {
    const batch = createInterceptBatch<{ kind: string }>();
    batch.collect({ kind: "submission" });
    batch.flush();
    batch.collect({ kind: "approval-request" });
    expect(batch.size()).toBe(1);
    expect(batch.peek()).toEqual([{ kind: "approval-request" }]);
  });
});

// ---------------------------------------------------------------------------
// Focus-change semantics — demonstrate focus=false → focus=true → focus=false
// ---------------------------------------------------------------------------

describe("routeEnvelope — focus transitions", () => {
  it("correctly routes the same envelope differently based on focus state", () => {
    // focus=false: supervisor handles via LLM
    expect(routeEnvelope("submission", false)).toBe("llm");

    // focus=true: human gets the dialog
    expect(routeEnvelope("submission", true)).toBe("human");

    // focus lost again: back to LLM
    expect(routeEnvelope("submission", false)).toBe("llm");
  });

  it("message kind never changes regardless of focus transitions", () => {
    expect(routeEnvelope("message", false)).toBe("llm");
    expect(routeEnvelope("message", true)).toBe("llm");
    expect(routeEnvelope("message", false)).toBe("llm");
  });
});
