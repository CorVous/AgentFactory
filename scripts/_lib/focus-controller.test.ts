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

// ── handleCrash — crash auto-shift to top supervisor ─────────────────────────

describe("FocusController — handleCrash: crash on non-focused peer is a no-op for focus", () => {
  it("does not change focus when a non-focused peer crashes", () => {
    const fc = createFocusController();
    fc.registerPeer("entry");
    fc.registerPeer("supervisor");
    fc.setFocus("entry");

    const focusEvents: Array<{ focused: string | null; prev: string | null }> = [];
    fc.on("focus-changed", (e: { focused: string | null; prev: string | null }) => focusEvents.push(e));

    // Crash on supervisor (not focused)
    fc.handleCrash("supervisor", "supervisor");

    expect(focusEvents).toHaveLength(0);
    expect(fc.getFocus()).toBe("entry");
  });

  it("emits crash-notice for non-focused peer crash", () => {
    const fc = createFocusController();
    fc.registerPeer("entry");
    fc.registerPeer("supervisor");
    fc.setFocus("entry");

    const notices: unknown[] = [];
    fc.on("crash-notice", (e: unknown) => notices.push(e));

    fc.handleCrash("supervisor", "supervisor");

    expect(notices).toHaveLength(1);
    expect((notices[0] as any).peerName).toBe("supervisor");
    expect((notices[0] as any).shiftedTo).toBeNull();
  });
});

describe("FocusController — handleCrash: crash on focused peer triggers shift to top", () => {
  it("shifts focus to top supervisor when the focused peer crashes", () => {
    const fc = createFocusController();
    fc.registerPeer("entry");
    fc.registerPeer("supervisor");
    fc.setFocus("entry");

    const focusEvents: Array<{ focused: string | null; prev: string | null }> = [];
    fc.on("focus-changed", (e: { focused: string | null; prev: string | null }) => focusEvents.push(e));

    fc.handleCrash("entry", "supervisor");

    expect(focusEvents).toHaveLength(1);
    expect(focusEvents[0].focused).toBe("supervisor");
    expect(focusEvents[0].prev).toBe("entry");
    expect(fc.getFocus()).toBe("supervisor");
  });

  it("sets auto-shift notice after shift", () => {
    const fc = createFocusController();
    fc.registerPeer("entry");
    fc.registerPeer("supervisor");
    fc.setFocus("entry");

    fc.handleCrash("entry", "supervisor");

    const notice = fc.getAutoShiftNotice();
    expect(notice).not.toBeNull();
    expect(notice).toContain("entry");
    expect(notice).toContain("supervisor");
  });

  it("emits crash-notice with shiftedTo=supervisor", () => {
    const fc = createFocusController();
    fc.registerPeer("entry");
    fc.registerPeer("supervisor");
    fc.setFocus("entry");

    const notices: unknown[] = [];
    fc.on("crash-notice", (e: unknown) => notices.push(e));

    fc.handleCrash("entry", "supervisor");

    expect(notices).toHaveLength(1);
    expect((notices[0] as any).peerName).toBe("entry");
    expect((notices[0] as any).shiftedTo).toBe("supervisor");
    expect((notices[0] as any).wasTopSupervisor).toBe(false);
  });

  it("clears focus to null if top supervisor is not registered (already crashed)", () => {
    const fc = createFocusController();
    fc.registerPeer("entry");
    // supervisor NOT registered (crashed before focus shift)
    fc.setFocus("entry");

    const focusEvents: Array<{ focused: string | null }> = [];
    fc.on("focus-changed", (e: { focused: string | null }) => focusEvents.push(e));

    fc.handleCrash("entry", "supervisor");

    expect(focusEvents).toHaveLength(1);
    expect(focusEvents[0].focused).toBeNull();
    expect(fc.getFocus()).toBeNull();
  });

  it("clears auto-shift notice on next setFocus call", () => {
    const fc = createFocusController();
    fc.registerPeer("entry");
    fc.registerPeer("supervisor");
    fc.registerPeer("other");
    fc.setFocus("entry");

    fc.handleCrash("entry", "supervisor");
    expect(fc.getAutoShiftNotice()).not.toBeNull();

    // Manual focus change should clear the notice.
    fc.setFocus("other");
    expect(fc.getAutoShiftNotice()).toBeNull();
  });

  it("clearAutoShiftNotice clears the notice", () => {
    const fc = createFocusController();
    fc.registerPeer("entry");
    fc.registerPeer("supervisor");
    fc.setFocus("entry");

    fc.handleCrash("entry", "supervisor");
    expect(fc.getAutoShiftNotice()).not.toBeNull();

    fc.clearAutoShiftNotice();
    expect(fc.getAutoShiftNotice()).toBeNull();
  });
});

describe("FocusController — handleCrash: crash on top supervisor itself", () => {
  it("does not shift focus when the top supervisor crashes while focused", () => {
    const fc = createFocusController();
    fc.registerPeer("supervisor");
    fc.registerPeer("worker");
    fc.setFocus("supervisor"); // supervisor is the focused peer

    const focusEvents: unknown[] = [];
    fc.on("focus-changed", (e: unknown) => focusEvents.push(e));

    // The supervisor crashes; it IS the top supervisor.
    fc.handleCrash("supervisor", "supervisor");

    expect(focusEvents).toHaveLength(0);
    // Focus stays on supervisor (it's already the top — no shift target).
    // (focus-changed was not emitted)
    expect(fc.getFocus()).toBe("supervisor");
  });

  it("sets a clear notice (not a shift notice) when top supervisor crashes", () => {
    const fc = createFocusController();
    fc.registerPeer("supervisor");
    fc.setFocus("supervisor");

    fc.handleCrash("supervisor", "supervisor");

    const notice = fc.getAutoShiftNotice();
    expect(notice).not.toBeNull();
    expect(notice).toContain("top supervisor");
    expect(notice).toContain("supervisor");
  });

  it("emits crash-notice with wasTopSupervisor=true when top supervisor crashes", () => {
    const fc = createFocusController();
    fc.registerPeer("supervisor");
    fc.setFocus("supervisor");

    const notices: unknown[] = [];
    fc.on("crash-notice", (e: unknown) => notices.push(e));

    fc.handleCrash("supervisor", "supervisor");

    expect(notices).toHaveLength(1);
    expect((notices[0] as any).wasTopSupervisor).toBe(true);
    expect((notices[0] as any).shiftedTo).toBeNull();
  });
});

// ── mesh-rail-update broadcast (AC-2 coverage) ────────────────────────────────

describe("FocusController — setBroadcast / _broadcastRailUpdate", () => {
  it("does not throw before setBroadcast is called", () => {
    const fc = createFocusController();
    expect(() => fc.registerPeer("peer-a")).not.toThrow();
  });

  it("setBroadcast causes registerPeer to emit a mesh-rail-update envelope", () => {
    const fc = createFocusController();
    const emitted: any[] = [];
    fc.setBroadcast((env) => emitted.push(env));

    fc.registerPeer("peer-a");

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("mesh-rail-update");
    expect(Array.isArray(emitted[0].peers)).toBe(true);
    expect(emitted[0].peers).toHaveLength(1);
    expect(emitted[0].peers[0].name).toBe("peer-a");
  });

  it("setBroadcast causes unregisterPeer to emit a mesh-rail-update envelope", () => {
    const fc = createFocusController();
    const emitted: any[] = [];
    fc.setBroadcast((env) => emitted.push(env));

    fc.registerPeer("peer-a");
    emitted.length = 0; // clear registerPeer emission

    fc.unregisterPeer("peer-a");

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("mesh-rail-update");
    expect(emitted[0].peers).toHaveLength(0);
  });

  it("setBroadcast causes setFocus to emit a mesh-rail-update envelope", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    const emitted: any[] = [];
    fc.setBroadcast((env) => emitted.push(env));

    fc.setFocus("peer-a");

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("mesh-rail-update");
  });

  it("setFocus no-op does NOT emit a mesh-rail-update envelope", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.setFocus("peer-a");
    const emitted: any[] = [];
    fc.setBroadcast((env) => emitted.push(env));

    fc.setFocus("peer-a"); // no-op

    expect(emitted).toHaveLength(0);
  });

  it("handleCrash on non-focused peer emits a mesh-rail-update envelope", () => {
    const fc = createFocusController();
    fc.registerPeer("entry");
    fc.registerPeer("supervisor");
    fc.setFocus("entry");
    const emitted: any[] = [];
    fc.setBroadcast((env) => emitted.push(env));

    fc.handleCrash("supervisor", "supervisor");

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("mesh-rail-update");
  });

  it("handleCrash on focused peer emits a mesh-rail-update envelope", () => {
    const fc = createFocusController();
    fc.registerPeer("entry");
    fc.registerPeer("supervisor");
    fc.setFocus("entry");
    const emitted: any[] = [];
    fc.setBroadcast((env) => emitted.push(env));

    fc.handleCrash("entry", "supervisor");

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("mesh-rail-update");
  });

  it("mesh-rail-update envelope carries decisionCount from injected getter", () => {
    const fc = createFocusController();
    const emitted: any[] = [];
    fc.setBroadcast((env) => emitted.push(env), () => 7);

    fc.registerPeer("peer-a");

    expect(emitted).toHaveLength(1);
    expect(emitted[0].decisionCount).toBe(7);
  });

  it("setPeerState emits a mesh-rail-update envelope with updated state", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    const emitted: any[] = [];
    fc.setBroadcast((env) => emitted.push(env));

    fc.setPeerState("peer-a", "crashed");

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("mesh-rail-update");
    const peer = emitted[0].peers.find((p: any) => p.name === "peer-a");
    expect(peer).toBeDefined();
    expect(peer.state).toBe("crashed");
  });

  it("setPeerDecisionPending emits a mesh-rail-update envelope", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    const emitted: any[] = [];
    fc.setBroadcast((env) => emitted.push(env));

    fc.setPeerDecisionPending("peer-a", true);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("mesh-rail-update");
    const peer = emitted[0].peers.find((p: any) => p.name === "peer-a");
    expect(peer).toBeDefined();
    expect(peer.decisionPending).toBe(true);
  });

  // Regression for "mesh-rail stuck at 0 peers" — peers connect to the
  // launcher socket asynchronously, after registerPeer() has already
  // broadcast. The launcher uses broadcastRailUpdate() on each
  // client-connected to catch the late arrival up to the current state.
  it("broadcastRailUpdate() re-emits the current snapshot on demand", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    fc.registerPeer("peer-b");
    const emitted: any[] = [];
    fc.setBroadcast((env) => emitted.push(env));

    fc.broadcastRailUpdate();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("mesh-rail-update");
    expect(emitted[0].peers.map((p: any) => p.name)).toEqual(["peer-a", "peer-b"]);
  });

  it("broadcastRailUpdate() is a no-op when no broadcast function is wired", () => {
    const fc = createFocusController();
    fc.registerPeer("peer-a");
    // No setBroadcast call — must not throw.
    expect(() => fc.broadcastRailUpdate()).not.toThrow();
  });
});
