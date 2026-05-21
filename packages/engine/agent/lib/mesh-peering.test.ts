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
  agentName: "solo-agent",
  scratchRoot: "/tmp/solo",
  busRoot: "/tmp/solo-bus",
  skills: [],
  agents: [],
  debug: false,
  supervisor: undefined,
  submitTo: undefined,
  acceptedFrom: [],
  peers: [],
};

describe("habitatHasPeers — solo (no peers)", () => {
  it("returns false when all four peer fields are empty/absent", () => {
    expect(habitatHasPeers(SOLO)).toBe(false);
  });

  it("returns false when acceptedFrom is empty and others absent", () => {
    expect(habitatHasPeers({ ...SOLO, acceptedFrom: [] })).toBe(false);
  });

  it("returns false when peers is empty and others absent", () => {
    expect(habitatHasPeers({ ...SOLO, peers: [] })).toBe(false);
  });
});

describe("habitatHasPeers — individual field triggers", () => {
  it("returns true when peers has one entry", () => {
    expect(habitatHasPeers({ ...SOLO, peers: ["worker-a"] })).toBe(true);
  });

  it("returns true when acceptedFrom has one entry", () => {
    expect(habitatHasPeers({ ...SOLO, acceptedFrom: ["authority"] })).toBe(true);
  });

  it("returns true when supervisor is set", () => {
    expect(habitatHasPeers({ ...SOLO, supervisor: "manager" })).toBe(true);
  });

  it("returns true when submitTo is set", () => {
    expect(habitatHasPeers({ ...SOLO, submitTo: "collector" })).toBe(true);
  });
});

describe("habitatHasPeers — combinations", () => {
  it("returns true when all four peer fields are populated", () => {
    expect(
      habitatHasPeers({
        ...SOLO,
        supervisor: "boss",
        submitTo: "sink",
        acceptedFrom: ["worker-a", "worker-b"],
        peers: ["boss", "sink"],
      }),
    ).toBe(true);
  });

  it("returns true when only peers and acceptedFrom are populated", () => {
    expect(
      habitatHasPeers({
        ...SOLO,
        acceptedFrom: ["authority"],
        peers: ["authority"],
      }),
    ).toBe(true);
  });

  it("returns false for empty string supervisor (treated as absent)", () => {
    // An empty-string supervisor is not a real peer — the predicate checks falsy.
    expect(habitatHasPeers({ ...SOLO, supervisor: "" })).toBe(false);
  });

  it("returns false for empty string submitTo (treated as absent)", () => {
    expect(habitatHasPeers({ ...SOLO, submitTo: "" })).toBe(false);
  });
});
