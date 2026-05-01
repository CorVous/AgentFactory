/**
 * focus-controller.test.ts — hermetic unit tests for FocusController.
 *
 * Contract: no I/O, no network, no env from models.env.
 */

import { describe, it, expect, vi } from "vitest";
import { createFocusController, FocusController } from "./focus-controller.mjs";

describe("FocusController — initial state", () => {
  it("getFocus() starts as null", () => {
    const fc = createFocusController();
    expect(fc.getFocus()).toBeNull();
  });

  it("listPeers() starts empty", () => {
    const fc = createFocusController();
    expect(fc.listPeers()).toEqual([]);
  });
});

describe("FocusController — registerPeer / listPeers", () => {
  it("registered peers appear in listPeers()", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.registerPeer("peer-b");
    expect(fc.listPeers()).toContain("peer-a");
    expect(fc.listPeers()).toContain("peer-b");
    expect(fc.listPeers()).toHaveLength(2);
  });

  it("registering the same peer twice is idempotent", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.registerPeer("peer-a");
    expect(fc.listPeers()).toHaveLength(1);
  });
});

describe("FocusController — setFocus", () => {
  it("setFocus to a registered peer returns ok:true and updates getFocus()", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    const result = fc.setFocus("peer-a");
    expect(result.ok).toBe(true);
    expect(fc.getFocus()).toBe("peer-a");
  });

  it("setFocus to a non-existent peer returns ok:false with reason", () => {
    const fc = createFocusController();
    const result = fc.setFocus("nobody");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown peer/);
    expect(fc.getFocus()).toBeNull(); // unchanged
  });

  it("setFocus to null clears focus (no-op if already null)", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.setFocus("peer-a");
    const result = fc.setFocus(null);
    expect(result.ok).toBe(true);
    expect(fc.getFocus()).toBeNull();
  });

  it("setFocus to the current peer is a no-op (no event, ok:true)", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.setFocus("peer-a");

    const listener = vi.fn();
    fc.on("focus-changed", listener);
    const result = fc.setFocus("peer-a");

    expect(result.ok).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("FocusController — focus-changed event", () => {
  it("emits focus-changed with focused and prev on change", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.registerPeer("peer-b");

    const events: Array<{ focused: string | null; prev: string | null }> = [];
    fc.on("focus-changed", (e) => events.push(e));

    fc.setFocus("peer-a");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ focused: "peer-a", prev: null });

    fc.setFocus("peer-b");
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ focused: "peer-b", prev: "peer-a" });
  });

  it("does NOT emit focus-changed when target == current (no-op)", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.setFocus("peer-a");

    const listener = vi.fn();
    fc.on("focus-changed", listener);
    fc.setFocus("peer-a");

    expect(listener).not.toHaveBeenCalled();
  });

  it("emits focus-changed with focused:null when unregisterPeer removes focused peer", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.setFocus("peer-a");

    const events: Array<{ focused: string | null; prev: string | null }> = [];
    fc.on("focus-changed", (e) => events.push(e));

    fc.unregisterPeer("peer-a");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ focused: null, prev: "peer-a" });
    expect(fc.getFocus()).toBeNull();
  });

  it("unregisterPeer on non-focused peer does not emit focus-changed", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.registerPeer("peer-b");
    fc.setFocus("peer-a");

    const listener = vi.fn();
    fc.on("focus-changed", listener);

    fc.unregisterPeer("peer-b");
    expect(listener).not.toHaveBeenCalled();
    expect(fc.getFocus()).toBe("peer-a");
  });
});

describe("FocusController — null focus", () => {
  it("setFocus(null) with no current focus is no-op (ok:true, no event)", () => {
    const fc = createFocusController();
    const listener = vi.fn();
    fc.on("focus-changed", listener);

    const result = fc.setFocus(null);
    expect(result.ok).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(fc.getFocus()).toBeNull();
  });
});
