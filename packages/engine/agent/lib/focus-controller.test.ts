/**
 * focus-controller.test.ts — engine-lib hermetic unit tests for FocusController.
 * Near-copy of scripts/_lib/focus-controller.test.ts, repointed at ../lib/focus-controller.mjs.
 *
 * Contract: no I/O, no network, no env from models.env.
 */

import { describe, it, expect, vi } from "vitest";
// @ts-ignore — no TS declarations for .mjs; same pattern as other engine-lib test files
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
    expect(fc.getFocus()).toBeNull();
  });
});

describe("FocusController — unregisterPeer", () => {
  it("unregistering the focused peer clears focus", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.setFocus("peer-a");
    fc.unregisterPeer("peer-a");
    expect(fc.getFocus()).toBeNull();
    expect(fc.listPeers()).toHaveLength(0);
  });

  it("unregistering a non-focused peer leaves focus unchanged", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.registerPeer("peer-b");
    fc.setFocus("peer-a");
    fc.unregisterPeer("peer-b");
    expect(fc.getFocus()).toBe("peer-a");
  });
});

describe("FocusController — setPeerState", () => {
  it("updates peer state without changing focus", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.setPeerState("peer-a", "crashed");
    // Just ensure no throw; state is internal.
    expect(fc.getFocus()).toBeNull();
  });

  it("is a no-op for unknown peers", () => {
    const fc = createFocusController();
    expect(() => fc.setPeerState("ghost", "crashed")).not.toThrow();
  });
});

describe("FocusController — broadcastRailUpdate", () => {
  it("calls the broadcast function with a mesh-rail-update envelope", () => {
    const fc = createFocusController();
    const broadcasts: unknown[] = [];
    fc.setBroadcast((env: unknown) => broadcasts.push(env), () => 0);
    fc.registerPeer("peer-a");
    // registerPeer triggers a broadcast
    expect(broadcasts.length).toBeGreaterThan(0);
    const last = broadcasts[broadcasts.length - 1] as any;
    expect(last.kind).toBe("mesh-rail-update");
    expect(last.peers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "peer-a" }),
    ]));
  });
});
