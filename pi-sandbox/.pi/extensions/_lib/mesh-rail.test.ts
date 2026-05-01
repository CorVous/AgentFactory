/**
 * mesh-rail.test.ts — hermetic unit tests for the mesh-rail widget component.
 *
 * Contract: no I/O, no network, no env from models.env, no real pi runtime.
 */

import { describe, it, expect } from "vitest";
import { visibleWidth } from "@mariozechner/pi-tui";
import { createMeshRailComponent } from "./mesh-rail";

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
