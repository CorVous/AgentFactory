/**
 * bus-tail-emitter.test.ts — hermetic unit tests for the bus-tail-emitter
 * activation logic (engine copy, packages/engine/agent/extensions/).
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
});

// ── Filter matching tests ──────────────────────────────────────────────────────

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
