// ref-resolver.test.ts — ported from pi-sandbox/.pi/extensions/_lib/ref-resolver.test.ts
// Imports from the canonical engine copy.

import { describe, it, expect } from "vitest";
import { resolveRef } from "./ref-resolver.js";

describe("resolveRef", () => {
  // ── expand-all ──────────────────────────────────────────────────────────────

  it("expand-all returns full member list verbatim, in order", () => {
    const members = ["r1", "r2", "r3"];
    expect(resolveRef("@reviewers", members, "expand-all", undefined)).toEqual(["r1", "r2", "r3"]);
  });

  it("expand-all with non-@ literal returns [literal]", () => {
    expect(resolveRef("concrete-name", undefined, "expand-all", undefined)).toEqual(["concrete-name"]);
  });

  // ── round-robin ─────────────────────────────────────────────────────────────

  it("round-robin with counter {value:0} returns members[0] and increments to 1", () => {
    const counter = { value: 0 };
    const result = resolveRef("@team", ["a", "b", "c"], "round-robin", counter);
    expect(result).toBe("a");
    expect(counter.value).toBe(1);
  });

  it("round-robin with counter {value:1} and 3-member group returns members[1], increments to 2", () => {
    const counter = { value: 1 };
    const result = resolveRef("@team", ["a", "b", "c"], "round-robin", counter);
    expect(result).toBe("b");
    expect(counter.value).toBe(2);
  });

  it("round-robin wrap-around: counter {value:5}, 3-member group → members[2], increments to 6", () => {
    const counter = { value: 5 };
    const result = resolveRef("@team", ["a", "b", "c"], "round-robin", counter);
    expect(result).toBe("c"); // 5 % 3 === 2
    expect(counter.value).toBe(6);
  });

  it("round-robin repeated calls — deterministic sequence [m0, m1, m2, m0, m1] for 3-member group", () => {
    const counter = { value: 0 };
    const members = ["m0", "m1", "m2"];
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(resolveRef("@team", members, "round-robin", counter));
    }
    expect(results).toEqual(["m0", "m1", "m2", "m0", "m1"]);
  });

  it("round-robin with non-@ literal returns the literal verbatim and does NOT mutate the counter", () => {
    const counter = { value: 3 };
    const result = resolveRef("literal-peer", undefined, "round-robin", counter);
    expect(result).toBe("literal-peer");
    expect(counter.value).toBe(3); // not mutated
  });

  it("round-robin without counterState throws", () => {
    expect(() =>
      resolveRef("@team", ["a", "b"], "round-robin", undefined),
    ).toThrow(/counterState|round-robin/i);
  });

  // ── first-listed ────────────────────────────────────────────────────────────

  it("first-listed returns members[0] regardless of counter", () => {
    const result = resolveRef("@team", ["first", "second", "third"], "first-listed", undefined);
    expect(result).toBe("first");
  });

  it("first-listed with non-@ literal returns the literal", () => {
    const result = resolveRef("direct-peer", undefined, "first-listed", undefined);
    expect(result).toBe("direct-peer");
  });

  // ── error cases ─────────────────────────────────────────────────────────────

  it("empty group rejection: @x with members:[] throws under expand-all; error includes group name", () => {
    expect(() =>
      resolveRef("@x", [], "expand-all", undefined),
    ).toThrow(/x/);
  });

  it("empty group rejection: @x with members:[] throws under round-robin; error includes group name", () => {
    const counter = { value: 0 };
    expect(() =>
      resolveRef("@x", [], "round-robin", counter),
    ).toThrow(/x/);
  });

  it("empty group rejection: @x with members:[] throws under first-listed; error includes group name", () => {
    expect(() =>
      resolveRef("@x", [], "first-listed", undefined),
    ).toThrow(/x/);
  });

  it("unknown group rejection: @x with members:undefined throws under expand-all; error indicates unknown + group name", () => {
    expect(() =>
      resolveRef("@x", undefined, "expand-all", undefined),
    ).toThrow(/unknown.*x|x.*unknown/i);
  });

  it("unknown group rejection: @x with members:undefined throws under round-robin; error indicates unknown + group name", () => {
    const counter = { value: 0 };
    expect(() =>
      resolveRef("@x", undefined, "round-robin", counter),
    ).toThrow(/unknown.*x|x.*unknown/i);
  });

  it("unknown group rejection: @x with members:undefined throws under first-listed; error indicates unknown + group name", () => {
    expect(() =>
      resolveRef("@x", undefined, "first-listed", undefined),
    ).toThrow(/unknown.*x|x.*unknown/i);
  });

  it("pass-through for non-@ strings under all three policies returns the literal with no error", () => {
    expect(resolveRef("peer-a", undefined, "expand-all", undefined)).toEqual(["peer-a"]);
    expect(resolveRef("peer-a", undefined, "round-robin", { value: 0 })).toBe("peer-a");
    expect(resolveRef("peer-a", undefined, "first-listed", undefined)).toBe("peer-a");
  });

  it("unknown policy throws", () => {
    // @ts-expect-error — testing invalid policy
    expect(() => resolveRef("@team", ["a"], "invalid-policy", undefined)).toThrow(/unknown policy/i);
  });
});
