// Tests for recipe-validation helpers (scripts/_lib/recipe-validation.mjs).
//
// rejectDeprecatedPeerFields:
//   - rejects each of the four deleted peer fields with exact error wording
//   - accepts a recipe that declares none of the four
//
// mergeBaselineTools:
//   - always includes respond_to_request even on an empty tools array
//   - deduplicates when respond_to_request is already present

import { describe, it, expect } from "vitest";
import {
  rejectDeprecatedPeerFields,
  mergeBaselineTools,
} from "./recipe-validation.mjs";

// ---------------------------------------------------------------------------
// rejectDeprecatedPeerFields
// ---------------------------------------------------------------------------

describe("rejectDeprecatedPeerFields", () => {
  function makeDie() {
    // Returns a die() that captures the message and throws so tests can assert.
    const calls = [];
    const fn = (msg) => {
      calls.push(msg);
      throw new Error(msg);
    };
    fn.calls = calls;
    return fn;
  }

  it("rejects 'supervisor' with the canonical error message", () => {
    const die = makeDie();
    expect(() =>
      rejectDeprecatedPeerFields({ supervisor: "lead-hare" }, "my-recipe", die),
    ).toThrow(
      "recipe my-recipe declares 'supervisor' which is no longer accepted; " +
        "peer wiring lives in the topology layer (see docs/agents.md ## Topology YAML)",
    );
    expect(die.calls).toHaveLength(1);
  });

  it("rejects 'submitTo' with the canonical error message", () => {
    const die = makeDie();
    expect(() =>
      rejectDeprecatedPeerFields({ submitTo: "collector" }, "my-recipe", die),
    ).toThrow(
      "recipe my-recipe declares 'submitTo' which is no longer accepted; " +
        "peer wiring lives in the topology layer (see docs/agents.md ## Topology YAML)",
    );
  });

  it("rejects 'acceptedFrom' with the canonical error message", () => {
    const die = makeDie();
    expect(() =>
      rejectDeprecatedPeerFields({ acceptedFrom: ["worker-a"] }, "my-recipe", die),
    ).toThrow(
      "recipe my-recipe declares 'acceptedFrom' which is no longer accepted; " +
        "peer wiring lives in the topology layer (see docs/agents.md ## Topology YAML)",
    );
  });

  it("rejects 'peers' with the canonical error message", () => {
    const die = makeDie();
    expect(() =>
      rejectDeprecatedPeerFields({ peers: ["planner"] }, "my-recipe", die),
    ).toThrow(
      "recipe my-recipe declares 'peers' which is no longer accepted; " +
        "peer wiring lives in the topology layer (see docs/agents.md ## Topology YAML)",
    );
  });

  it("accepts a recipe that declares none of the four deprecated fields", () => {
    const die = makeDie();
    // Should not throw; die should never be called.
    expect(() =>
      rejectDeprecatedPeerFields(
        { model: "TASK_RABBIT_MODEL", tools: ["read"], prompt: "you are a helper" },
        "clean-recipe",
        die,
      ),
    ).not.toThrow();
    expect(die.calls).toHaveLength(0);
  });

  it("only checks the four deprecated fields; other unknown fields are ignored", () => {
    const die = makeDie();
    expect(() =>
      rejectDeprecatedPeerFields(
        { unknownField: "whatever", anotherField: 42 },
        "some-recipe",
        die,
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// mergeBaselineTools
// ---------------------------------------------------------------------------

describe("mergeBaselineTools", () => {
  it("includes respond_to_request even when input is empty", () => {
    const result = mergeBaselineTools([]);
    expect(result).toContain("respond_to_request");
  });

  it("preserves existing tools alongside respond_to_request", () => {
    const result = mergeBaselineTools(["read", "write"]);
    expect(result).toContain("respond_to_request");
    expect(result).toContain("read");
    expect(result).toContain("write");
  });

  it("deduplicates when respond_to_request is already present", () => {
    const result = mergeBaselineTools(["respond_to_request", "read"]);
    const count = result.filter((t) => t === "respond_to_request").length;
    expect(count).toBe(1);
  });

  it("does not mutate the input array", () => {
    const input = ["read"];
    mergeBaselineTools(input);
    expect(input).toEqual(["read"]);
  });

  it("baseline tools appear at the front of the result", () => {
    const result = mergeBaselineTools(["read", "write"]);
    expect(result[0]).toBe("respond_to_request");
  });
});
