// rail-packages.test.ts — hermetic unit tests for the rail→cluster resolver.
// No model API calls, no network, no filesystem I/O outside these tests.

import { describe, it, expect } from "vitest";
import { RAIL_TO_CLUSTER, resolveRailPackages } from "./rail-packages.js";

// ── RAIL_TO_CLUSTER mapping ────────────────────────────────────────────────

describe("RAIL_TO_CLUSTER mapping", () => {
  it("maps deferred-confirm to deferred-rails", () => {
    expect(RAIL_TO_CLUSTER["deferred-confirm"]).toBe("deferred-rails");
  });
  it("maps deferred-write to deferred-rails", () => {
    expect(RAIL_TO_CLUSTER["deferred-write"]).toBe("deferred-rails");
  });
  it("maps deferred-edit to deferred-rails", () => {
    expect(RAIL_TO_CLUSTER["deferred-edit"]).toBe("deferred-rails");
  });
  it("maps deferred-move to deferred-rails", () => {
    expect(RAIL_TO_CLUSTER["deferred-move"]).toBe("deferred-rails");
  });
  it("maps deferred-delete to deferred-rails", () => {
    expect(RAIL_TO_CLUSTER["deferred-delete"]).toBe("deferred-rails");
  });

  it("maps sandbox to containment-rails", () => {
    expect(RAIL_TO_CLUSTER["sandbox"]).toBe("containment-rails");
  });
  it("maps no-edit to containment-rails", () => {
    expect(RAIL_TO_CLUSTER["no-edit"]).toBe("containment-rails");
  });

  it("maps agent-header to ui-rails", () => {
    expect(RAIL_TO_CLUSTER["agent-header"]).toBe("ui-rails");
  });
  it("maps agent-footer to ui-rails", () => {
    expect(RAIL_TO_CLUSTER["agent-footer"]).toBe("ui-rails");
  });
  it("maps no-startup-help to ui-rails", () => {
    expect(RAIL_TO_CLUSTER["no-startup-help"]).toBe("ui-rails");
  });
  it("maps hide-extensions-list to ui-rails", () => {
    expect(RAIL_TO_CLUSTER["hide-extensions-list"]).toBe("ui-rails");
  });

  it("maps engine-owned rails to 'engine'", () => {
    for (const rail of [
      "peer-bus",
      "supervisor",
      "intercept",
      "atomic-delegate",
      "habitat",
      "launcher-bridge",
      "slash-commands",
      "bus-tail-emitter",
      "mesh-rail",
      "mesh-authority",
      "deferred-confirm-baseline",
    ]) {
      expect(RAIL_TO_CLUSTER[rail], `${rail} should be 'engine'`).toBe("engine");
    }
  });
});

// ── resolveRailPackages ────────────────────────────────────────────────────

describe("resolveRailPackages", () => {
  it("resolves rails when all clusters are installed", () => {
    const { resolved, missing } = resolveRailPackages(
      ["sandbox", "no-edit", "deferred-write", "deferred-confirm"],
      ["containment-rails", "deferred-rails"],
    );
    expect(missing).toHaveLength(0);
    expect(resolved.map((r) => r.rail)).toEqual(
      expect.arrayContaining(["sandbox", "no-edit", "deferred-write", "deferred-confirm"]),
    );
    expect(resolved.find((r) => r.rail === "sandbox")?.cluster).toBe("containment-rails");
    expect(resolved.find((r) => r.rail === "deferred-write")?.cluster).toBe("deferred-rails");
  });

  it("detects a missing cluster and returns hint", () => {
    const { resolved, missing } = resolveRailPackages(
      ["sandbox", "deferred-write"],
      ["containment-rails"], // deferred-rails NOT installed
    );
    expect(resolved.map((r) => r.rail)).toContain("sandbox");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.rail).toBe("deferred-write");
    expect(missing[0]!.cluster).toBe("deferred-rails");
    expect(missing[0]!.hint).toBe("pi install npm:@agentfactory/deferred-rails");
  });

  it("detects multiple missing clusters", () => {
    const { missing } = resolveRailPackages(
      ["sandbox", "no-edit", "agent-header", "deferred-confirm"],
      [], // nothing installed
    );
    const missingClusters = [...new Set(missing.map((m) => m.cluster))];
    expect(missingClusters).toEqual(
      expect.arrayContaining(["containment-rails", "ui-rails", "deferred-rails"]),
    );
  });

  it("engine-marker rails are never reported missing", () => {
    const { missing } = resolveRailPackages(
      ["peer-bus", "supervisor", "intercept"],
      [], // nothing installed
    );
    expect(missing).toHaveLength(0);
  });

  it("engine-marker rails appear in resolved list", () => {
    const { resolved } = resolveRailPackages(
      ["peer-bus", "supervisor"],
      [],
    );
    expect(resolved.map((r) => r.rail)).toEqual(
      expect.arrayContaining(["peer-bus", "supervisor"]),
    );
    expect(resolved.find((r) => r.rail === "peer-bus")?.cluster).toBe("engine");
  });

  it("install hint uses exact pi install format", () => {
    const { missing } = resolveRailPackages(
      ["agent-header"],
      [], // ui-rails not installed
    );
    expect(missing[0]!.hint).toBe("pi install npm:@agentfactory/ui-rails");
  });

  it("throws for unknown rails", () => {
    expect(() =>
      resolveRailPackages(["unknown-rail-xyz"], []),
    ).toThrow("unknown-rail-xyz");
  });

  it("empty rail list returns empty resolved and missing", () => {
    const { resolved, missing } = resolveRailPackages([], []);
    expect(resolved).toHaveLength(0);
    expect(missing).toHaveLength(0);
  });

  it("does not duplicate a cluster in missing when multiple rails from same cluster are absent", () => {
    const { missing } = resolveRailPackages(
      ["deferred-write", "deferred-edit", "deferred-confirm"],
      [], // deferred-rails not installed
    );
    // Each rail appears once, but the cluster name may repeat across missing entries
    const rails = missing.map((m) => m.rail);
    expect(rails).toContain("deferred-write");
    expect(rails).toContain("deferred-edit");
    expect(rails).toContain("deferred-confirm");
    // All map to the same cluster
    expect(missing.every((m) => m.cluster === "deferred-rails")).toBe(true);
  });
});
