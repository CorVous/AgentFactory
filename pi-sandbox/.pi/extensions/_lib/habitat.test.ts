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
    expect(h.rpcSock).toBeUndefined();
    expect(h.delegationId).toBeUndefined();
  });

  it("preserves all optional fields when present", () => {
    const spec = JSON.stringify({
      agentName: "x-writer",
      scratchRoot: "/tmp/s",
      busRoot: "/tmp/b",
      description: "Does things",
      tier: "TASK_RABBIT_MODEL",
      type: "deferred-writer",
      rpcSock: "/tmp/pi-rpc-123.sock",
      delegationId: "abc-def",
      skills: ["pi-agent-builder"],
      agents: ["deferred-writer"],
      noEditAdd: ["my_tool"],
      noEditSkip: ["deferred_write"],
    });
    const h = materialiseHabitat(spec);
    expect(h.description).toBe("Does things");
    expect(h.tier).toBe("TASK_RABBIT_MODEL");
    expect(h.type).toBe("deferred-writer");
    expect(h.rpcSock).toBe("/tmp/pi-rpc-123.sock");
    expect(h.delegationId).toBe("abc-def");
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
