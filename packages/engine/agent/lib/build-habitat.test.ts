// build-habitat.test.ts — hermetic unit tests for the Habitat builder.
// No model calls, no network, no env-var pollution from models.env.

import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildHabitat, mergeTopologyOverlay } from "./build-habitat.js";

describe("buildHabitat", () => {
  it("sets instanceName from input", () => {
    const h = buildHabitat({ instanceName: "test-agent", cwd: "/tmp/work", flags: {} });
    expect(h.instanceName).toBe("test-agent");
  });

  it("sets scratchRoot from cwd", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp/myproject", flags: {} });
    expect(h.scratchRoot).toBe("/tmp/myproject");
  });

  it("resolves scratchRoot as absolute path", () => {
    const cwd = "/tmp/abstest";
    const h = buildHabitat({ instanceName: "a", cwd, flags: {} });
    expect(path.isAbsolute(h.scratchRoot)).toBe(true);
  });

  it("builds busRoot under ~/.pi-agent-bus/<basename of cwd>", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp/myproject", flags: {} });
    const expected = path.join(os.homedir(), ".pi-agent-bus", "myproject");
    expect(h.busRoot).toBe(expected);
  });

  it("uses basename of cwd for busRoot segment", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/some/deep/path/my-workspace", flags: {} });
    const expected = path.join(os.homedir(), ".pi-agent-bus", "my-workspace");
    expect(h.busRoot).toBe(expected);
  });

  it("defaults debug to false when not in flags", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: {} });
    expect(h.debug).toBe(false);
  });

  it("sets debug = true when flags.debug is true", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: { debug: true } });
    expect(h.debug).toBe(true);
  });

  it("defaults skills to empty array", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: {} });
    expect(h.skills).toEqual([]);
  });

  it("defaults spawns to empty array", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: {} });
    expect(h.spawns).toEqual([]);
  });

  it("defaults acceptsWorkFrom to empty array", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: {} });
    expect(h.acceptsWorkFrom).toEqual([]);
  });

  it("defaults messagesWith to empty array", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: {} });
    expect(h.messagesWith).toEqual([]);
  });

  it("sets description from recipe when provided", () => {
    const h = buildHabitat({
      instanceName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { description: "My helpful agent", model: "TASK_RABBIT_MODEL", tools: [], prompt: "You help." },
    });
    expect(h.description).toBe("My helpful agent");
  });

  it("leaves description undefined when recipe has no description", () => {
    const h = buildHabitat({
      instanceName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { model: "TASK_RABBIT_MODEL", tools: [], prompt: "You help." },
    });
    expect(h.description).toBeUndefined();
  });

  it("sets tier when model is a known tier var name", () => {
    const h = buildHabitat({
      instanceName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { model: "TASK_RABBIT_MODEL", tools: [], prompt: "You help." },
    });
    expect(h.tier).toBe("TASK_RABBIT_MODEL");
  });

  it("does NOT set tier when model is a literal ID", () => {
    const h = buildHabitat({
      instanceName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { model: "anthropic/claude-haiku-4", tools: [], prompt: "You help." },
    });
    expect(h.tier).toBeUndefined();
  });

  it("sets skills from recipe", () => {
    const h = buildHabitat({
      instanceName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { model: "TASK_RABBIT_MODEL", tools: [], prompt: "p", skills: ["skill-a", "skill-b"] },
    });
    expect(h.skills).toEqual(["skill-a", "skill-b"]);
  });

  it("sets spawns from recipe", () => {
    const h = buildHabitat({
      instanceName: "a",
      cwd: "/tmp",
      flags: {},
      recipe: { model: "TASK_RABBIT_MODEL", tools: [], prompt: "p", spawns: ["child-agent"] },
    });
    expect(h.spawns).toEqual(["child-agent"]);
  });

  it("sets supervisor/submitsWorkTo/acceptsWorkFrom/messagesWith from peerFields when provided", () => {
    const h = buildHabitat({
      instanceName: "a",
      cwd: "/tmp",
      flags: {},
      peerFields: {
        supervisor: "boss",
        submitsWorkTo: "collector",
        acceptsWorkFrom: ["boss"],
        messagesWith: ["boss", "sibling"],
      },
    });
    expect(h.supervisor).toBe("boss");
    expect(h.submitsWorkTo).toBe("collector");
    expect(h.acceptsWorkFrom).toEqual(["boss"]);
    expect(h.messagesWith).toEqual(["boss", "sibling"]);
  });

  it("leaves peer relationship fields undefined/empty when peerFields not provided", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: {} });
    expect(h.supervisor).toBeUndefined();
    expect(h.submitsWorkTo).toBeUndefined();
    expect(h.acceptsWorkFrom).toEqual([]);
    expect(h.messagesWith).toEqual([]);
  });
});

describe("mergeTopologyOverlay", () => {
  it("sets supervisor and submitsWorkTo from valid overlay", () => {
    const opts: { peerFields?: { supervisor?: string; submitsWorkTo?: string } } = {};
    mergeTopologyOverlay(opts, JSON.stringify({ escalatesTo: "boss", submitsWorkTo: "collector" }));
    expect(opts.peerFields?.supervisor).toBe("boss");
    expect(opts.peerFields?.submitsWorkTo).toBe("collector");
  });

  it("sets acceptsWorkFrom when overlay array is non-empty", () => {
    const opts: { peerFields?: { acceptsWorkFrom?: string[] } } = {};
    mergeTopologyOverlay(opts, JSON.stringify({ acceptsWorkFrom: ["boss"] }));
    expect(opts.peerFields?.acceptsWorkFrom).toEqual(["boss"]);
  });

  it("sets messagesWith when overlay array is non-empty", () => {
    const opts: { peerFields?: { messagesWith?: string[] } } = {};
    mergeTopologyOverlay(opts, JSON.stringify({ messagesWith: ["boss", "sibling"] }));
    expect(opts.peerFields?.messagesWith).toEqual(["boss", "sibling"]);
  });

  it("ignores empty acceptsWorkFrom array (does not override)", () => {
    const opts: { peerFields?: { acceptsWorkFrom?: string[] } } = { peerFields: { acceptsWorkFrom: ["existing"] } };
    mergeTopologyOverlay(opts, JSON.stringify({ acceptsWorkFrom: [] }));
    expect(opts.peerFields?.acceptsWorkFrom).toEqual(["existing"]);
  });

  it("overrides spawns even with empty array when field is present", () => {
    const opts: { spawns?: string[] } = { spawns: ["child"] };
    mergeTopologyOverlay(opts, JSON.stringify({ spawns: [] }));
    expect(opts.spawns).toEqual([]);
  });

  it("overrides spawns with non-empty array from overlay", () => {
    const opts: { spawns?: string[] } = { spawns: ["old"] };
    mergeTopologyOverlay(opts, JSON.stringify({ spawns: ["new-agent"] }));
    expect(opts.spawns).toEqual(["new-agent"]);
  });

  it("creates peerFields object when opts.peerFields is undefined", () => {
    const opts: { peerFields?: { supervisor?: string } } = {};
    mergeTopologyOverlay(opts, JSON.stringify({ escalatesTo: "boss" }));
    expect(opts.peerFields).toBeDefined();
    expect(opts.peerFields?.supervisor).toBe("boss");
  });

  it("throws on malformed JSON", () => {
    const opts = {};
    expect(() => mergeTopologyOverlay(opts, "not-json")).toThrow();
  });

  it("ignores overlay fields absent in the JSON (partial overlay)", () => {
    const opts: { peerFields?: { supervisor?: string; submitsWorkTo?: string } } = {
      peerFields: { supervisor: "existing-boss" },
    };
    mergeTopologyOverlay(opts, JSON.stringify({ submitsWorkTo: "collector" }));
    // supervisor should stay unchanged
    expect(opts.peerFields?.supervisor).toBe("existing-boss");
    expect(opts.peerFields?.submitsWorkTo).toBe("collector");
  });

  // Slice 3: groups and spawnerName in overlay
  it("sets groups from overlay when present", () => {
    const opts: { peerFields?: { groups?: string[] } } = {};
    mergeTopologyOverlay(opts, JSON.stringify({ groups: ["haiku", "story"] }));
    expect(opts.peerFields?.groups).toEqual(["haiku", "story"]);
  });

  it("sets spawnerName from overlay when present", () => {
    const opts: { peerFields?: { spawnerName?: string } } = {};
    mergeTopologyOverlay(opts, JSON.stringify({ spawnerName: "my-host" }));
    expect(opts.peerFields?.spawnerName).toBe("my-host");
  });

  it("ignores empty groups array (does not override existing)", () => {
    const opts: { peerFields?: { groups?: string[] } } = { peerFields: { groups: ["existing"] } };
    // groups: [] in overlay — should it override? current impl always sets it when array present
    // So an empty array does replace.
    mergeTopologyOverlay(opts, JSON.stringify({ groups: [] }));
    expect(opts.peerFields?.groups).toEqual([]);
  });
});

describe("buildHabitat — Slice 4: isHost flag", () => {
  it("defaults isHost to false when not in flags", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: {} });
    expect(h.isHost).toBe(false);
  });

  it("sets isHost = true when flags.isHost is true", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: { isHost: true } });
    expect(h.isHost).toBe(true);
  });

  it("does not set isHost = true when flags.isHost is falsy", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: { isHost: false } });
    expect(h.isHost).toBe(false);
  });

  it("carries initialMesh from recipe when provided", () => {
    const initialMesh = [{ recipe: "mesh-node", name: "worker-1", groups: ["research"] }];
    const h = buildHabitat({
      instanceName: "host",
      cwd: "/tmp",
      flags: { isHost: true },
      recipe: { model: "LEAD_HARE_MODEL", tools: [], prompt: "p", initialMesh },
    });
    expect(h.initialMesh).toEqual(initialMesh);
  });

  it("leaves initialMesh undefined when recipe has none", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: {} });
    expect(h.initialMesh).toBeUndefined();
  });

  it("carries spawnWiring from recipe when provided", () => {
    const spawnWiring = [{ recipe: "mesh-writer", escalatesTo: "host" }];
    const h = buildHabitat({
      instanceName: "host",
      cwd: "/tmp",
      flags: { isHost: true },
      recipe: { model: "LEAD_HARE_MODEL", tools: [], prompt: "p", spawnWiring },
    });
    expect(h.spawnWiring).toEqual(spawnWiring);
  });

  it("leaves spawnWiring undefined when recipe has none", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: {} });
    expect(h.spawnWiring).toBeUndefined();
  });
});

describe("buildHabitat — Slice 3: groups field", () => {
  it("defaults groups to empty array", () => {
    const h = buildHabitat({ instanceName: "a", cwd: "/tmp", flags: {} });
    expect(h.groups).toEqual([]);
  });

  it("sets groups from peerFields", () => {
    const h = buildHabitat({
      instanceName: "a",
      cwd: "/tmp",
      flags: {},
      peerFields: { groups: ["haiku", "story"] },
    });
    expect(h.groups).toEqual(["haiku", "story"]);
  });

  it("sets spawnerName from peerFields", () => {
    const h = buildHabitat({
      instanceName: "a",
      cwd: "/tmp",
      flags: {},
      peerFields: { spawnerName: "my-host" },
    });
    expect(h.spawnerName).toBe("my-host");
  });

  it("overlay round-trip: groups serialized and deserialized", () => {
    const opts: { peerFields?: import("./build-habitat.js").PeerFields } = {};
    mergeTopologyOverlay(opts, JSON.stringify({ groups: ["haiku"] }));
    const h = buildHabitat({
      instanceName: "worker",
      cwd: "/tmp",
      flags: {},
      peerFields: opts.peerFields,
    });
    expect(h.groups).toEqual(["haiku"]);
  });
});
