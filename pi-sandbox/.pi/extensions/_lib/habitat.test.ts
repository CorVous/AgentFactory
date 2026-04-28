import { describe, it, expect, beforeEach } from "vitest";
import { materialiseHabitat, setHabitat, getHabitat, type Habitat } from "./habitat";

// Wipe the globalThis stash between tests so set/get tests are isolated.
beforeEach(() => {
  (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__ = undefined;
});

// ---------------------------------------------------------------------------
// materialiseHabitat
// ---------------------------------------------------------------------------

const MINIMAL_VALID = JSON.stringify({
  agentName: "cottontail-writer",
  scratchRoot: "/tmp/scratch",
  busRoot: "/home/user/.pi-agent-bus/scratch",
});

describe("materialiseHabitat", () => {
  it("returns a Habitat for a minimal valid spec", () => {
    const h = materialiseHabitat(MINIMAL_VALID);
    expect(h.agentName).toBe("cottontail-writer");
    expect(h.scratchRoot).toBe("/tmp/scratch");
    expect(h.busRoot).toBe("/home/user/.pi-agent-bus/scratch");
  });

  it("defaults list fields to [] when absent", () => {
    const h = materialiseHabitat(MINIMAL_VALID);
    expect(h.skills).toEqual([]);
    expect(h.agents).toEqual([]);
    expect(h.noEditAdd).toEqual([]);
    expect(h.noEditSkip).toEqual([]);
  });

  it("optional string fields are undefined when absent", () => {
    const h = materialiseHabitat(MINIMAL_VALID);
    expect(h.description).toBeUndefined();
    expect(h.tier).toBeUndefined();
    expect(h.type).toBeUndefined();
  });

  it("preserves all optional fields when present", () => {
    const spec = JSON.stringify({
      agentName: "x-writer",
      scratchRoot: "/tmp/s",
      busRoot: "/tmp/b",
      description: "Does things",
      tier: "TASK_RABBIT_MODEL",
      type: "deferred-writer",
      skills: ["pi-agent-builder"],
      agents: ["deferred-writer"],
      noEditAdd: ["my_tool"],
      noEditSkip: ["deferred_write"],
    });
    const h = materialiseHabitat(spec);
    expect(h.description).toBe("Does things");
    expect(h.tier).toBe("TASK_RABBIT_MODEL");
    expect(h.type).toBe("deferred-writer");
    expect(h.skills).toEqual(["pi-agent-builder"]);
    expect(h.agents).toEqual(["deferred-writer"]);
    expect(h.noEditAdd).toEqual(["my_tool"]);
    expect(h.noEditSkip).toEqual(["deferred_write"]);
  });

  it("throws on malformed JSON", () => {
    expect(() => materialiseHabitat("{not valid")).toThrow();
  });

  it("throws when agentName is missing", () => {
    const spec = JSON.stringify({ scratchRoot: "/tmp/s", busRoot: "/tmp/b" });
    expect(() => materialiseHabitat(spec)).toThrow(/agentName/);
  });

  it("throws when scratchRoot is missing", () => {
    const spec = JSON.stringify({ agentName: "a", busRoot: "/tmp/b" });
    expect(() => materialiseHabitat(spec)).toThrow(/scratchRoot/);
  });

  it("throws when busRoot is missing", () => {
    const spec = JSON.stringify({ agentName: "a", scratchRoot: "/tmp/s" });
    expect(() => materialiseHabitat(spec)).toThrow(/busRoot/);
  });

  it("throws when agentName is not a string", () => {
    const spec = JSON.stringify({ agentName: 42, scratchRoot: "/tmp/s", busRoot: "/tmp/b" });
    expect(() => materialiseHabitat(spec)).toThrow(/agentName/);
  });

  it("throws when scratchRoot is not a string", () => {
    const spec = JSON.stringify({ agentName: "a", scratchRoot: null, busRoot: "/tmp/b" });
    expect(() => materialiseHabitat(spec)).toThrow(/scratchRoot/);
  });

  it("throws when busRoot is not a string", () => {
    const spec = JSON.stringify({ agentName: "a", scratchRoot: "/tmp/s", busRoot: [] });
    expect(() => materialiseHabitat(spec)).toThrow(/busRoot/);
  });

  it("ignores non-string items in list fields", () => {
    const spec = JSON.stringify({
      agentName: "a",
      scratchRoot: "/tmp/s",
      busRoot: "/tmp/b",
      skills: ["valid", 42, null, "also-valid"],
    });
    const h = materialiseHabitat(spec);
    expect(h.skills).toEqual(["valid", "also-valid"]);
  });

  it("treats a non-array list field as []", () => {
    const spec = JSON.stringify({
      agentName: "a",
      scratchRoot: "/tmp/s",
      busRoot: "/tmp/b",
      skills: "pi-agent-builder",
    });
    const h = materialiseHabitat(spec);
    expect(h.skills).toEqual([]);
  });

  // Phase 3b: peer relationship fields
  it("defaults peer list fields to [] when absent", () => {
    const h = materialiseHabitat(MINIMAL_VALID);
    expect(h.acceptedFrom).toEqual([]);
    expect(h.peers).toEqual([]);
  });

  it("defaults peer optional string fields to undefined when absent", () => {
    const h = materialiseHabitat(MINIMAL_VALID);
    expect(h.supervisor).toBeUndefined();
    expect(h.submitTo).toBeUndefined();
  });

  it("preserves peer fields when present", () => {
    const spec = JSON.stringify({
      agentName: "x-writer",
      scratchRoot: "/tmp/s",
      busRoot: "/tmp/b",
      supervisor: "lead-hare",
      submitTo: "collector",
      acceptedFrom: ["worker-a", "worker-b"],
      peers: ["planner", "reviewer"],
    });
    const h = materialiseHabitat(spec);
    expect(h.supervisor).toBe("lead-hare");
    expect(h.submitTo).toBe("collector");
    expect(h.acceptedFrom).toEqual(["worker-a", "worker-b"]);
    expect(h.peers).toEqual(["planner", "reviewer"]);
  });

  it("treats non-string supervisor as undefined (type mismatch rejected)", () => {
    const spec = JSON.stringify({
      agentName: "a",
      scratchRoot: "/tmp/s",
      busRoot: "/tmp/b",
      supervisor: 42,
    });
    const h = materialiseHabitat(spec);
    expect(h.supervisor).toBeUndefined();
  });

  it("treats non-string submitTo as undefined (type mismatch rejected)", () => {
    const spec = JSON.stringify({
      agentName: "a",
      scratchRoot: "/tmp/s",
      busRoot: "/tmp/b",
      submitTo: { name: "collector" },
    });
    const h = materialiseHabitat(spec);
    expect(h.submitTo).toBeUndefined();
  });

  it("treats non-array acceptedFrom as [] (type mismatch rejected)", () => {
    const spec = JSON.stringify({
      agentName: "a",
      scratchRoot: "/tmp/s",
      busRoot: "/tmp/b",
      acceptedFrom: "worker-a",
    });
    const h = materialiseHabitat(spec);
    expect(h.acceptedFrom).toEqual([]);
  });

  it("treats non-array peers as [] (type mismatch rejected)", () => {
    const spec = JSON.stringify({
      agentName: "a",
      scratchRoot: "/tmp/s",
      busRoot: "/tmp/b",
      peers: 99,
    });
    const h = materialiseHabitat(spec);
    expect(h.peers).toEqual([]);
  });

  it("ignores non-string items in acceptedFrom and peers", () => {
    const spec = JSON.stringify({
      agentName: "a",
      scratchRoot: "/tmp/s",
      busRoot: "/tmp/b",
      acceptedFrom: ["worker-a", 42, null, "worker-b"],
      peers: [true, "planner", 0],
    });
    const h = materialiseHabitat(spec);
    expect(h.acceptedFrom).toEqual(["worker-a", "worker-b"]);
    expect(h.peers).toEqual(["planner"]);
  });
});

// ---------------------------------------------------------------------------
// setHabitat / getHabitat
// ---------------------------------------------------------------------------

describe("setHabitat / getHabitat", () => {
  it("getHabitat throws before setHabitat is called", () => {
    expect(() => getHabitat()).toThrow();
  });

  it("getHabitat returns the habitat after setHabitat", () => {
    const h = materialiseHabitat(MINIMAL_VALID);
    setHabitat(h);
    expect(getHabitat()).toBe(h);
  });

  it("stashes on globalThis under __pi_habitat__", () => {
    const h = materialiseHabitat(MINIMAL_VALID);
    setHabitat(h);
    expect((globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__).toBe(h);
  });

  it("overwrite: setHabitat replaces previous value", () => {
    const h1 = materialiseHabitat(MINIMAL_VALID);
    const h2 = materialiseHabitat(
      JSON.stringify({ agentName: "b", scratchRoot: "/tmp/b", busRoot: "/tmp/bb" }),
    );
    setHabitat(h1);
    setHabitat(h2);
    expect(getHabitat().agentName).toBe("b");
  });
});
