/**
 * mesh-rail.test.ts — hermetic unit tests for the mesh-rail widget component.
 *
 * Contract: no I/O, no network, no env from models.env, no real pi runtime.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
  createMeshRailComponent,
  setMeshRailHandle,
  getMeshRailHandle,
  clearMeshRailHandle,
} from "./mesh-rail";

describe("createMeshRailComponent — placeholder content", () => {
  it("renders the peer name", () => {
    const component = createMeshRailComponent({ peerName: "cottontail-writer" });
    const lines = component.render(80);
    expect(lines.join("\n")).toContain("cottontail-writer");
  });

  it("renders '0 peers'", () => {
    const component = createMeshRailComponent({ peerName: "any-peer" });
    expect(component.render(80).join("\n")).toContain("0 peers");
  });

  it("renders '0 decisions'", () => {
    const component = createMeshRailComponent({ peerName: "any-peer" });
    expect(component.render(80).join("\n")).toContain("0 decisions");
  });

  it("returned component implements the pi-tui Component interface (render + invalidate)", () => {
    const component = createMeshRailComponent({ peerName: "any-peer" });
    expect(typeof component.render).toBe("function");
    expect(typeof component.invalidate).toBe("function");
    const lines = component.render(80);
    expect(Array.isArray(lines)).toBe(true);
    for (const line of lines) expect(typeof line).toBe("string");
  });

  it("renders fields horizontally on a single line", () => {
    const component = createMeshRailComponent({ peerName: "any-peer" });
    const lines = component.render(80);
    expect(lines).toHaveLength(1);
    // peer-name appears before peer-count; peer-count appears before decisions-count.
    const line = lines[0];
    const iName = line.indexOf("any-peer");
    const iPeers = line.indexOf("0 peers");
    const iDecisions = line.indexOf("0 decisions");
    expect(iName).toBeGreaterThanOrEqual(0);
    expect(iPeers).toBeGreaterThan(iName);
    expect(iDecisions).toBeGreaterThan(iPeers);
  });

  it("uses no box-drawing characters (no border)", () => {
    const component = createMeshRailComponent({ peerName: "any-peer" });
    const all = component.render(80).join("");
    for (const ch of ["╭", "╮", "╰", "╯", "│", "─", "┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼"]) {
      expect(all).not.toContain(ch);
    }
  });

  it("does not exceed the column budget (truncates with ellipsis when narrower than content)", () => {
    const component = createMeshRailComponent({ peerName: "very-long-peer-name" });
    const narrow = 12;
    const lines = component.render(narrow);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(narrow);
  });
});

// ── live update (AC-4 coverage) ───────────────────────────────────────────────

describe("createMeshRailComponent — update() / live state", () => {
  it("update() with peers changes the rendered peer count", () => {
    const component = createMeshRailComponent({ peerName: "me" });

    component.update({
      peers: [
        { name: "peer-a", state: "running", decisionPending: false },
        { name: "peer-b", state: "crashed", decisionPending: true },
      ],
    });

    const line = component.render(200).join("");
    // Should no longer show "0 peers" once real peers are present.
    expect(line).not.toContain("0 peers");
    expect(line).toContain("peer-a");
    expect(line).toContain("peer-b");
  });

  it("update() with decisionCount changes the decisions label", () => {
    const component = createMeshRailComponent({ peerName: "me" });

    component.update({ decisionCount: 3 });

    const line = component.render(200).join("");
    expect(line).toContain("3 decisions");
    expect(line).not.toContain("0 decisions");
  });

  it("update() with decisionCount: 1 renders '1 decision' (singular)", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    component.update({ decisionCount: 1 });
    expect(component.render(200).join("")).toContain("1 decision");
  });

  it("partial update() leaves unchanged fields intact", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    component.update({ decisionCount: 5 });

    // Only update peers; decisionCount should remain 5.
    component.update({ peers: [{ name: "peer-x", state: "running", decisionPending: false }] });

    const state = component.getState();
    expect(state.decisionCount).toBe(5);
    expect(state.peers).toHaveLength(1);
  });

  it("getState() returns a copy of the current state", () => {
    const component = createMeshRailComponent({ peerName: "me", initialDecisionCount: 2 });
    const s = component.getState();
    expect(s.peerName).toBe("me");
    expect(s.decisionCount).toBe(2);
    expect(Array.isArray(s.peers)).toBe(true);
  });

  it("update() calls the injected invalidate callback", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    const invalidateSpy = vi.fn();
    (component as any)._setInvalidate(invalidateSpy);

    component.update({ decisionCount: 1 });

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("state icon for crashed peer appears in rendered output", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    component.update({ peers: [{ name: "peer-a", state: "crashed", decisionPending: false }] });
    const line = component.render(200).join("");
    expect(line).toContain("✗");
  });

  it("state icon for running peer appears in rendered output", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    component.update({ peers: [{ name: "peer-a", state: "running", decisionPending: false }] });
    const line = component.render(200).join("");
    expect(line).toContain("●");
  });
});

// ── handle stash (AC-4 coverage) ─────────────────────────────────────────────

describe("setMeshRailHandle / getMeshRailHandle / clearMeshRailHandle", () => {
  afterEach(() => {
    clearMeshRailHandle();
  });

  it("getMeshRailHandle() returns null before set", () => {
    clearMeshRailHandle();
    expect(getMeshRailHandle()).toBeNull();
  });

  it("setMeshRailHandle / getMeshRailHandle round-trips the handle", () => {
    const handle = createMeshRailComponent({ peerName: "test-peer" });
    setMeshRailHandle(handle);
    expect(getMeshRailHandle()).toBe(handle);
  });

  it("clearMeshRailHandle sets the stash back to null", () => {
    const handle = createMeshRailComponent({ peerName: "test-peer" });
    setMeshRailHandle(handle);
    clearMeshRailHandle();
    expect(getMeshRailHandle()).toBeNull();
  });

  it("setMeshRailHandle replaces a previous handle", () => {
    const h1 = createMeshRailComponent({ peerName: "peer-1" });
    const h2 = createMeshRailComponent({ peerName: "peer-2" });
    setMeshRailHandle(h1);
    setMeshRailHandle(h2);
    expect(getMeshRailHandle()).toBe(h2);
    expect(getMeshRailHandle()).not.toBe(h1);
  });
});

// ── setHidden / isHidden (AC-2 coverage) ─────────────────────────────────────

describe("createMeshRailComponent — setHidden / isHidden", () => {
  it("isHidden() returns false by default", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    expect(component.isHidden()).toBe(false);
  });

  it("setHidden(true) makes render() return an empty array", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    component.setHidden(true);
    expect(component.render(80)).toEqual([]);
  });

  it("setHidden(false) restores normal rendering", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    component.setHidden(true);
    component.setHidden(false);
    const lines = component.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("me");
  });

  it("setHidden(true) calls the injected invalidate callback", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    const invalidateSpy = vi.fn();
    (component as any)._setInvalidate(invalidateSpy);

    component.setHidden(true);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("setHidden(false) calls the injected invalidate callback", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    const invalidateSpy = vi.fn();
    (component as any)._setInvalidate(invalidateSpy);

    component.setHidden(true);
    invalidateSpy.mockClear();
    component.setHidden(false);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("isHidden() reflects the most recent setHidden call", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    expect(component.isHidden()).toBe(false);
    component.setHidden(true);
    expect(component.isHidden()).toBe(true);
    component.setHidden(false);
    expect(component.isHidden()).toBe(false);
  });
});

// ── decisions field in state (AC-1 coverage) ─────────────────────────────────

describe("createMeshRailComponent — decisions in state", () => {
  it("getState() includes an empty decisions array by default", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    const s = component.getState();
    expect(Array.isArray(s.decisions)).toBe(true);
    expect(s.decisions).toHaveLength(0);
  });

  it("update() with decisions updates the state", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    component.update({
      decisions: [
        { msg_id: "m1", peer: "worker-a", kind: "approval-request", summary: "build step", pinned: false },
      ],
    });
    const s = component.getState();
    expect(s.decisions).toHaveLength(1);
    expect(s.decisions[0]!.msg_id).toBe("m1");
    expect(s.decisions[0]!.peer).toBe("worker-a");
  });

  it("partial update() with only decisions leaves peers and decisionCount unchanged", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    component.update({ decisionCount: 7, peers: [{ name: "p1", state: "running", decisionPending: false }] });
    component.update({
      decisions: [{ msg_id: "m2", peer: "p1", kind: "submission", summary: "artifacts", pinned: true }],
    });
    const s = component.getState();
    expect(s.decisionCount).toBe(7);
    expect(s.peers).toHaveLength(1);
    expect(s.decisions).toHaveLength(1);
    expect(s.decisions[0]!.pinned).toBe(true);
  });

  it("getState() returns a copy of decisions (not a reference)", () => {
    const component = createMeshRailComponent({ peerName: "me" });
    component.update({
      decisions: [{ msg_id: "x", peer: "p", kind: "k", summary: "s", pinned: false }],
    });
    const s1 = component.getState();
    s1.decisions.push({ msg_id: "y", peer: "q", kind: "k2", summary: "s2", pinned: false });
    const s2 = component.getState();
    expect(s2.decisions).toHaveLength(1); // mutation of copy didn't affect state
  });
});
