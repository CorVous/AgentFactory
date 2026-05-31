/**
 * habitat-glue.test.ts — real behavioural tests for habitat-glue.ts.
 *
 * Verifies:
 *   1. tryGetHabitat returns null when no Habitat is set.
 *   2. tryGetHabitat returns the Habitat when one has been set.
 *   3. tryGetHabitat does NOT throw (contrast with getHabitat).
 *   4. getHabitat still throws when no Habitat is set (regression guard).
 *
 * These are live behavioural tests against the real module.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setHabitat, getHabitat, tryGetHabitat } from "./habitat-glue.js";
import type { Habitat } from "./habitat-types.js";

// Minimal valid Habitat for testing (all required fields per habitat-types.ts).
function makeMinimalHabitat(): Habitat {
  return {
    instanceName: "test-agent",
    scratchRoot: "/tmp/test",
    busRoot: "/tmp/test/.pi/bus",
    skills: [],
    spawns: [],
    debug: false,
    isHost: false,
    acceptsWorkFrom: [],
    messagesWith: [],
    groups: [],
  };
}

describe("habitat-glue.ts — tryGetHabitat (issue #173)", () => {
  beforeEach(() => {
    // Clear the global Habitat before each test.
    delete (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__;
  });

  it("returns null when no Habitat is set", () => {
    expect(tryGetHabitat()).toBeNull();
  });

  it("returns the Habitat when one has been set", () => {
    const h = makeMinimalHabitat();
    setHabitat(h);
    expect(tryGetHabitat()).toBe(h);
  });

  it("does NOT throw when no Habitat is set (contrast with getHabitat)", () => {
    expect(() => tryGetHabitat()).not.toThrow();
  });

  it("getHabitat still throws when no Habitat is set (regression guard)", () => {
    expect(() => getHabitat()).toThrow(/has not been materialised/);
  });

  it("returns null again after clearing the global", () => {
    const h = makeMinimalHabitat();
    setHabitat(h);
    expect(tryGetHabitat()).toBe(h);
    delete (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__;
    expect(tryGetHabitat()).toBeNull();
  });
});
