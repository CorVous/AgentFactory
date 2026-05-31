/**
 * mesh-peering.test.ts — unit tests for habitatHasPeers predicate.
 *
 * The predicate is the single gate for "should this session bind a bus socket
 * / connect to the launcher". A solo run (no peers) returns false; any
 * populated peer field returns true.
 *
 * Contract: hermetic — no I/O, no model calls, no env vars.
 */

import { describe, it, expect } from "vitest";
import { habitatHasPeers } from "./mesh-peering.js";
import type { Habitat } from "./habitat-types.js";

/** Baseline solo Habitat — all four peer fields empty / absent. */
const SOLO: Habitat = {
  instanceName: "solo-agent",
  scratchRoot: "/tmp/solo",
  busRoot: "/tmp/solo-bus",
  skills: [],
  spawns: [],
  debug: false,
  isHost: false,
  supervisor: undefined,
  submitsWorkTo: undefined,
  acceptsWorkFrom: [],
  messagesWith: [],
  groups: [],
};

describe("habitatHasPeers — solo (no peers)", () => {
  it("returns false when all four peer fields are empty/absent", () => {
    expect(habitatHasPeers(SOLO)).toBe(false);
  });

  it("returns false when acceptedFrom is empty and others absent", () => {
    expect(habitatHasPeers({ ...SOLO, acceptsWorkFrom: [] })).toBe(false);
  });

  it("returns false when peers is empty and others absent", () => {
    expect(habitatHasPeers({ ...SOLO, messagesWith: [] })).toBe(false);
  });
});

describe("habitatHasPeers — individual field triggers", () => {
  it("returns true when peers has one entry", () => {
    expect(habitatHasPeers({ ...SOLO, messagesWith: ["worker-a"] })).toBe(true);
  });

  it("returns true when acceptedFrom has one entry", () => {
    expect(habitatHasPeers({ ...SOLO, acceptsWorkFrom: ["authority"] })).toBe(true);
  });

  it("returns true when supervisor is set", () => {
    expect(habitatHasPeers({ ...SOLO, supervisor: "manager" })).toBe(true);
  });

  it("returns true when submitTo is set", () => {
    expect(habitatHasPeers({ ...SOLO, submitsWorkTo: "collector" })).toBe(true);
  });
});

describe("habitatHasPeers — combinations", () => {
  it("returns true when all four peer fields are populated", () => {
    expect(
      habitatHasPeers({
        ...SOLO,
        supervisor: "boss",
        submitsWorkTo: "sink",
        acceptsWorkFrom: ["worker-a", "worker-b"],
        messagesWith: ["boss", "sink"],
      }),
    ).toBe(true);
  });

  it("returns true when only peers and acceptedFrom are populated", () => {
    expect(
      habitatHasPeers({
        ...SOLO,
        acceptsWorkFrom: ["authority"],
        messagesWith: ["authority"],
      }),
    ).toBe(true);
  });

  it("returns false for empty string supervisor (treated as absent)", () => {
    // An empty-string supervisor is not a real peer — the predicate checks falsy.
    expect(habitatHasPeers({ ...SOLO, supervisor: "" })).toBe(false);
  });

  it("returns false for empty string submitTo (treated as absent)", () => {
    expect(habitatHasPeers({ ...SOLO, submitsWorkTo: "" })).toBe(false);
  });
});
