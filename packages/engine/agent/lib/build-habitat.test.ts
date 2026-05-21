// build-habitat.test.ts — hermetic unit tests for the Habitat builder.
// No model calls, no network, no env-var pollution from models.env.

import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildHabitat } from "./build-habitat.js";

describe("buildHabitat", () => {
  it("sets agentName from input", () => {
    const h = buildHabitat({ agentName: "test-agent", cwd: "/tmp/work", flags: {} });
    expect(h.agentName).toBe("test-agent");
  });

  it("sets scratchRoot from cwd", () => {
    const h = buildHabitat({ agentName: "a", cwd: "/tmp/myproject", flags: {} });
    expect(h.scratchRoot).toBe("/tmp/myproject");
  });

  it("resolves scratchRoot as absolute path", () => {
    const cwd = "/tmp/abstest";
    const h = buildHabitat({ agentName: "a", cwd, flags: {} });
    expect(path.isAbsolute(h.scratchRoot)).toBe(true);
  });

  it("builds busRoot under ~/.pi-agent-bus/<basename of cwd>", () => {
    const h = buildHabitat({ agentName: "a", cwd: "/tmp/myproject", flags: {} });
    const expected = path.join(os.homedir(), ".pi-agent-bus", "myproject");
    expect(h.busRoot).toBe(expected);
  });

  it("uses basename of cwd for busRoot segment", () => {
    const h = buildHabitat({ agentName: "a", cwd: "/some/deep/path/my-workspace", flags: {} });
    const expected = path.join(os.homedir(), ".pi-agent-bus", "my-workspace");
    expect(h.busRoot).toBe(expected);
  });

  it("defaults debug to false when not in flags", () => {
    const h = buildHabitat({ agentName: "a", cwd: "/tmp", flags: {} });
    expect(h.debug).toBe(false);
  });

  it("sets debug = true when flags.debug is true", () => {
    const h = buildHabitat({ agentName: "a", cwd: "/tmp", flags: { debug: true } });
    expect(h.debug).toBe(true);
  });

  it("defaults skills to empty array", () => {
    const h = buildHabitat({ agentName: "a", cwd: "/tmp", flags: {} });
    expect(h.skills).toEqual([]);
  });

  it("defaults agents to empty array", () => {
    const h = buildHabitat({ agentName: "a", cwd: "/tmp", flags: {} });
    expect(h.agents).toEqual([]);
  });

  it("defaults acceptedFrom to empty array", () => {
    const h = buildHabitat({ agentName: "a", cwd: "/tmp", flags: {} });
    expect(h.acceptedFrom).toEqual([]);
  });

  it("defaults peers to empty array", () => {
    const h = buildHabitat({ agentName: "a", cwd: "/tmp", flags: {} });
    expect(h.peers).toEqual([]);
  });

  it("sets description from recipe when provided", () => {
    const h = buildHabitat({
      agentName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { description: "My helpful agent", model: "TASK_RABBIT_MODEL", tools: [], prompt: "You help." },
    });
    expect(h.description).toBe("My helpful agent");
  });

  it("leaves description undefined when recipe has no description", () => {
    const h = buildHabitat({
      agentName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { model: "TASK_RABBIT_MODEL", tools: [], prompt: "You help." },
    });
    expect(h.description).toBeUndefined();
  });

  it("sets tier when model is a known tier var name", () => {
    const h = buildHabitat({
      agentName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { model: "TASK_RABBIT_MODEL", tools: [], prompt: "You help." },
    });
    expect(h.tier).toBe("TASK_RABBIT_MODEL");
  });

  it("does NOT set tier when model is a literal ID", () => {
    const h = buildHabitat({
      agentName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { model: "anthropic/claude-haiku-4", tools: [], prompt: "You help." },
    });
    expect(h.tier).toBeUndefined();
  });

  it("sets skills from recipe", () => {
    const h = buildHabitat({
      agentName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { model: "TASK_RABBIT_MODEL", tools: [], prompt: "p", skills: ["skill-a", "skill-b"] },
    });
    expect(h.skills).toEqual(["skill-a", "skill-b"]);
  });

  it("sets agents from recipe", () => {
    const h = buildHabitat({
      agentName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { model: "TASK_RABBIT_MODEL", tools: [], prompt: "p", agents: ["child-agent"] },
    });
    expect(h.agents).toEqual(["child-agent"]);
  });

  it("sets supervisor/submitTo/acceptedFrom/peers from peerFields when provided", () => {
    const h = buildHabitat({
      agentName: "a",
      cwd: "/tmp",
      flags: {},
      peerFields: {
        supervisor: "boss",
        submitTo: "collector",
        acceptedFrom: ["boss"],
        peers: ["boss", "sibling"],
      },
    });
    expect(h.supervisor).toBe("boss");
    expect(h.submitTo).toBe("collector");
    expect(h.acceptedFrom).toEqual(["boss"]);
    expect(h.peers).toEqual(["boss", "sibling"]);
  });

  it("leaves peer relationship fields undefined/empty when peerFields not provided", () => {
    const h = buildHabitat({ agentName: "a", cwd: "/tmp", flags: {} });
    expect(h.supervisor).toBeUndefined();
    expect(h.submitTo).toBeUndefined();
    expect(h.acceptedFrom).toEqual([]);
    expect(h.peers).toEqual([]);
  });
});
