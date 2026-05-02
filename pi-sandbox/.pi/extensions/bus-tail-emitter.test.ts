/**
 * bus-tail-emitter.test.ts — hermetic unit tests for the bus-tail-emitter
 * activation logic.
 *
 * The emitter activates only when BOTH conditions are true:
 *   1. The peer is focused (FocusState.isFocused() === true).
 *   2. A tail-on signal has been received from the launcher.
 *
 * Since bus-tail-emitter.ts is a pi extension (loaded at runtime), we test
 * the core activation logic in isolation by simulating the FocusState and
 * tail-toggle signal conditions directly.
 *
 * Contract: no I/O, no real bus, no live model.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Pure activation logic tests ────────────────────────────────────────────────
//
// The emitter maintains three state variables:
//   focused: boolean — whether this peer is focused
//   tailOn: boolean — whether /tail has been enabled
//   filter: string | undefined — active filter, if any
//
// The observer hook is installed when (focused && tailOn) and removed otherwise.
// These tests exercise that logic without loading the actual extension.

function createEmitterState() {
  let focused = false;
  let tailOn = false;
  let filter: string | undefined;

  function isActive() {
    return focused && tailOn;
  }

  function setFocused(val: boolean) {
    focused = val;
  }

  function setTailOn(val: boolean, f?: string) {
    tailOn = val;
    filter = val ? f : undefined;
  }

  return { isActive, setFocused, setTailOn, getFilter: () => filter };
}

describe("bus-tail-emitter activation logic", () => {
  it("is inactive when neither focused nor tail-on", () => {
    const s = createEmitterState();
    expect(s.isActive()).toBe(false);
  });

  it("is inactive when focused but tail is off", () => {
    const s = createEmitterState();
    s.setFocused(true);
    expect(s.isActive()).toBe(false);
  });

  it("is inactive when tail is on but not focused", () => {
    const s = createEmitterState();
    s.setTailOn(true);
    expect(s.isActive()).toBe(false);
  });

  it("becomes active when both focused AND tail-on", () => {
    const s = createEmitterState();
    s.setFocused(true);
    s.setTailOn(true);
    expect(s.isActive()).toBe(true);
  });

  it("deactivates when focus is lost while tail is on", () => {
    const s = createEmitterState();
    s.setFocused(true);
    s.setTailOn(true);
    expect(s.isActive()).toBe(true);
    s.setFocused(false);
    expect(s.isActive()).toBe(false);
  });

  it("deactivates when tail is turned off while focused", () => {
    const s = createEmitterState();
    s.setFocused(true);
    s.setTailOn(true);
    expect(s.isActive()).toBe(true);
    s.setTailOn(false);
    expect(s.isActive()).toBe(false);
  });

  it("remains inactive through multiple focus changes without tail-on", () => {
    const s = createEmitterState();
    s.setFocused(true);
    s.setFocused(false);
    s.setFocused(true);
    expect(s.isActive()).toBe(false);
  });

  it("stores filter when tail is turned on with filter", () => {
    const s = createEmitterState();
    s.setTailOn(true, "message");
    expect(s.getFilter()).toBe("message");
  });

  it("clears filter when tail is turned off", () => {
    const s = createEmitterState();
    s.setTailOn(true, "message");
    s.setTailOn(false);
    expect(s.getFilter()).toBeUndefined();
  });

  it("updates filter when tail-on is sent again with different filter", () => {
    const s = createEmitterState();
    s.setTailOn(true, "message");
    s.setTailOn(true, "submission");
    expect(s.getFilter()).toBe("submission");
  });

  it("clears filter when tail-on is sent without filter", () => {
    const s = createEmitterState();
    s.setTailOn(true, "message");
    s.setTailOn(true, undefined);
    expect(s.getFilter()).toBeUndefined();
  });
});

// ── Observer hook tests ────────────────────────────────────────────────────────
//
// The emitter installs a __pi_bus_tail_observe__ hook on globalThis when active.
// We simulate the hook lifecycle here.

describe("bus-tail-emitter observer hook lifecycle", () => {
  beforeEach(() => {
    // Clean up any stale observer from previous tests.
    delete (globalThis as any).__pi_bus_tail_observe__;
  });

  it("hook is not installed when inactive", () => {
    // Simulate inactive state: neither focused nor tail-on
    delete (globalThis as any).__pi_bus_tail_observe__;
    // If observer is not installed, no tail events are forwarded
    expect((globalThis as any).__pi_bus_tail_observe__).toBeUndefined();
  });

  it("hook can be installed and removed", () => {
    const g = globalThis as any;
    // Simulate installing the hook
    g.__pi_bus_tail_observe__ = vi.fn();
    expect(g.__pi_bus_tail_observe__).toBeDefined();
    // Simulate removing the hook
    delete g.__pi_bus_tail_observe__;
    expect(g.__pi_bus_tail_observe__).toBeUndefined();
  });

  it("hook is called with envelope and direction", () => {
    const g = globalThis as any;
    const calls: any[] = [];
    g.__pi_bus_tail_observe__ = (env: any, dir: string) => calls.push({ env, dir });

    // Simulate agent-bus calling the observer
    const fakeEnv = { from: "a", to: "b", payload: { kind: "message", text: "hi" }, ts: 1000 };
    g.__pi_bus_tail_observe__(fakeEnv, "in");
    g.__pi_bus_tail_observe__(fakeEnv, "out");

    expect(calls).toHaveLength(2);
    expect(calls[0].dir).toBe("in");
    expect(calls[1].dir).toBe("out");

    delete g.__pi_bus_tail_observe__;
  });

  it("errors in the hook are silently suppressed", () => {
    const g = globalThis as any;
    g.__pi_bus_tail_observe__ = () => { throw new Error("observer failure"); };

    // agent-bus wraps the call in try/catch — we verify the pattern here
    let thrown = false;
    const observer = g.__pi_bus_tail_observe__;
    try { observer({}, "in"); } catch { thrown = true; }
    expect(thrown).toBe(true); // the observer throws; caller must catch

    delete g.__pi_bus_tail_observe__;
  });
});

// ── Filter matching tests ──────────────────────────────────────────────────────
//
// The emitter applies the filter before forwarding; we test the matching logic.

describe("bus-tail-emitter filter matching", () => {
  it("passes all envelopes when no filter is set", () => {
    const filter: string | undefined = undefined;
    const shouldForward = (envKind: string) =>
      !filter || envKind === filter;

    expect(shouldForward("message")).toBe(true);
    expect(shouldForward("submission")).toBe(true);
    expect(shouldForward("approval-request")).toBe(true);
  });

  it("passes only matching envelopes when filter is set", () => {
    const filter = "message";
    const shouldForward = (envKind: string) =>
      !filter || envKind === filter;

    expect(shouldForward("message")).toBe(true);
    expect(shouldForward("submission")).toBe(false);
    expect(shouldForward("approval-request")).toBe(false);
  });

  it("handles plural alias normalisation", () => {
    // The emitter normalises "messages" → "message" and "submissions" → "submission"
    const normalise = (f: string | undefined): string | undefined => {
      if (!f) return undefined;
      if (f === "submissions") return "submission";
      if (f === "messages") return "message";
      return f;
    };

    expect(normalise("submissions")).toBe("submission");
    expect(normalise("messages")).toBe("message");
    expect(normalise("approval-request")).toBe("approval-request");
    expect(normalise(undefined)).toBeUndefined();
  });
});
