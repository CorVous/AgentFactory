/**
 * mesh-rail.test.ts — hermetic unit tests for mesh-rail overlay state, render, and handle.
 *
 * Contract: no I/O, no network, no env from models.env, no real pi runtime.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getMeshRailHandle,
  setMeshRailHandle,
  clearMeshRailHandle,
  createMeshRailComponent,
  meshRailOverlayOptions,
} from "./mesh-rail";

describe("mesh-rail handle stash (globalThis)", () => {
  beforeEach(() => {
    clearMeshRailHandle();
  });

  it("getMeshRailHandle() returns undefined before any handle is registered", () => {
    expect(getMeshRailHandle()).toBeUndefined();
  });

  it("setMeshRailHandle(h) makes getMeshRailHandle() return that handle", () => {
    const fakeHandle = {
      hide: () => {},
      setHidden: (_: boolean) => {},
      isHidden: () => false,
      focus: () => {},
      unfocus: () => {},
      isFocused: () => false,
    };
    setMeshRailHandle(fakeHandle);
    expect(getMeshRailHandle()).toBe(fakeHandle);
  });

  it("clearMeshRailHandle() resets the stash", () => {
    const fakeHandle = {
      hide: () => {},
      setHidden: (_: boolean) => {},
      isHidden: () => false,
      focus: () => {},
      unfocus: () => {},
      isFocused: () => false,
    };
    setMeshRailHandle(fakeHandle);
    clearMeshRailHandle();
    expect(getMeshRailHandle()).toBeUndefined();
  });
});

describe("createMeshRailComponent — placeholder content", () => {
  it("renders a header line containing the peer name", () => {
    const component = createMeshRailComponent({ peerName: "cottontail-writer" });
    const lines = component.render(40);
    const all = lines.join("\n");
    expect(all).toContain("cottontail-writer");
  });

  it("renders a line containing '0 peers'", () => {
    const component = createMeshRailComponent({ peerName: "any-peer" });
    const lines = component.render(40);
    const all = lines.join("\n");
    expect(all).toContain("0 peers");
  });

  it("renders a line containing '0 decisions'", () => {
    const component = createMeshRailComponent({ peerName: "any-peer" });
    const lines = component.render(40);
    const all = lines.join("\n");
    expect(all).toContain("0 decisions");
  });

  it("returned component implements the pi-tui Component interface (render + invalidate)", () => {
    const component = createMeshRailComponent({ peerName: "any-peer" });
    expect(typeof component.render).toBe("function");
    expect(typeof component.invalidate).toBe("function");
    // Sanity: render returns an array of strings.
    const lines = component.render(40);
    expect(Array.isArray(lines)).toBe(true);
    for (const line of lines) expect(typeof line).toBe("string");
  });

  it("draws an ASCII box: top and bottom border lines plus side bars on content lines", () => {
    const component = createMeshRailComponent({ peerName: "any-peer" });
    const lines = component.render(30);
    // First and last lines are corner-to-corner border runs.
    expect(lines[0]).toMatch(/^\+-+\+$/);
    expect(lines[lines.length - 1]).toMatch(/^\+-+\+$/);
    // Every line in between begins with `|` and ends with `|`.
    for (let i = 1; i < lines.length - 1; i++) {
      expect(lines[i].startsWith("|")).toBe(true);
      expect(lines[i].endsWith("|")).toBe(true);
    }
  });

  it("pads each rendered line to the same visible width (so the box is rectangular)", () => {
    const component = createMeshRailComponent({ peerName: "any-peer" });
    const lines = component.render(30);
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });
});

describe("meshRailOverlayOptions", () => {
  it("anchors the overlay to top-right", () => {
    expect(meshRailOverlayOptions().anchor).toBe("top-right");
  });

  it("sets width to '30%'", () => {
    expect(meshRailOverlayOptions().width).toBe("30%");
  });

  it("is non-capturing so the editor keeps focus", () => {
    expect(meshRailOverlayOptions().nonCapturing).toBe(true);
  });

  it("sets a top margin of 1 to clear the agent header", () => {
    const opts = meshRailOverlayOptions();
    const margin = opts.margin;
    if (typeof margin === "number") {
      expect(margin).toBeGreaterThanOrEqual(1);
    } else {
      expect(margin?.top).toBe(1);
    }
  });

  it("sets a bounded maxHeight (caps growth so chat below is not obscured)", () => {
    const { maxHeight } = meshRailOverlayOptions();
    expect(maxHeight).toBeDefined();
    // Bounded: either a small absolute number of rows or a percentage cap.
    if (typeof maxHeight === "number") {
      expect(maxHeight).toBeGreaterThan(0);
      expect(maxHeight).toBeLessThanOrEqual(20);
    } else {
      // Percentage like "30%": parse and assert it's a real cap (< 100%).
      expect(maxHeight).toMatch(/^\d+%$/);
      const pct = Number((maxHeight as string).slice(0, -1));
      expect(pct).toBeGreaterThan(0);
      expect(pct).toBeLessThan(100);
    }
  });
});
