// peer-spawn.test.ts — hermetic unit tests for the shared spawn library.
// No model calls, no network, no real child processes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeWorkerHabitatOverlay,
  serializeHabitatOverlay,
  copyWorkspace,
  runMeshSpawn,
  parseRef,
  classifyBareRef,
  applyEntryWiringToOverlay,
  resolveInitialMeshRefs,
  resolveInitialMeshScalarRef,
  type WorkerHandle,
  type SpawnArgs,
  type MeshSpawnContext,
} from "./peer-spawn.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Create a tmpdir, return its path. */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "peer-spawn-test-"));
}

/** Build a fake WorkerHandle that never exits (unless explicitly resolved). */
function makePendingHandle(): WorkerHandle & { resolve: (code?: number) => void } {
  let resolveExit!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    resolveExit = res;
  });
  const killMock = vi.fn();
  return {
    pid: 1234,
    exited,
    kill: killMock,
    resolve: (code = 0) => resolveExit({ code, signal: null }),
  };
}

// ── computeWorkerHabitatOverlay ───────────────────────────────────────────

describe("computeWorkerHabitatOverlay", () => {
  it("returns an overlay with the caller as all peer fields", () => {
    const overlay = computeWorkerHabitatOverlay("caller-agent");
    expect(overlay.supervisor).toBe("caller-agent");
    expect(overlay.submitsWorkTo).toBe("caller-agent");
    expect(overlay.acceptsWorkFrom).toEqual(["caller-agent"]);
    expect(overlay.messagesWith).toEqual(["caller-agent"]);
    expect(overlay.spawns).toEqual([]);
  });

  it("uses new vocabulary field names (not old agent/submitTo/peers)", () => {
    const overlay = computeWorkerHabitatOverlay("parent");
    expect("submitTo" in overlay).toBe(false);
    expect("agents" in overlay).toBe(false);
    expect("peers" in overlay).toBe(false);
    expect("acceptedFrom" in overlay).toBe(false);
  });
});

// ── serializeHabitatOverlay ──────────────────────────────────────────────

describe("serializeHabitatOverlay", () => {
  it("maps supervisor → escalatesTo in the JSON output", () => {
    const overlay = computeWorkerHabitatOverlay("boss");
    const json = JSON.parse(serializeHabitatOverlay(overlay));
    expect(json.escalatesTo).toBe("boss");
    expect("supervisor" in json).toBe(false);
  });

  it("serializes submitsWorkTo, acceptsWorkFrom, messagesWith, spawns", () => {
    const overlay = computeWorkerHabitatOverlay("boss");
    const json = JSON.parse(serializeHabitatOverlay(overlay));
    expect(json.submitsWorkTo).toBe("boss");
    expect(json.acceptsWorkFrom).toEqual(["boss"]);
    expect(json.messagesWith).toEqual(["boss"]);
    expect(json.spawns).toEqual([]);
  });
});

// ── copyWorkspace ────────────────────────────────────────────────────────

describe("copyWorkspace", () => {
  it("copies a single file into scratchRoot preserving relative path", () => {
    const callerSandbox = makeTmpDir();
    const scratchRoot = makeTmpDir();
    fs.writeFileSync(path.join(callerSandbox, "hello.txt"), "hi");
    copyWorkspace(callerSandbox, scratchRoot, ["hello.txt"]);
    expect(fs.existsSync(path.join(scratchRoot, "hello.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(scratchRoot, "hello.txt"), "utf8")).toBe("hi");
  });

  it("recursively copies a subdirectory", () => {
    const callerSandbox = makeTmpDir();
    const scratchRoot = makeTmpDir();
    const subdir = path.join(callerSandbox, "sub");
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, "file.ts"), "content");
    copyWorkspace(callerSandbox, scratchRoot, ["sub"]);
    expect(fs.existsSync(path.join(scratchRoot, "sub", "file.ts"))).toBe(true);
  });

  it("silently skips paths that escape the caller sandbox", () => {
    const callerSandbox = makeTmpDir();
    const scratchRoot = makeTmpDir();
    // Escape attempt via ../
    copyWorkspace(callerSandbox, scratchRoot, ["../etc/passwd"]);
    expect(fs.readdirSync(scratchRoot)).toHaveLength(0);
  });

  it("silently skips non-existent paths", () => {
    const callerSandbox = makeTmpDir();
    const scratchRoot = makeTmpDir();
    copyWorkspace(callerSandbox, scratchRoot, ["nonexistent.txt"]);
    expect(fs.readdirSync(scratchRoot)).toHaveLength(0);
  });

  it("empty include list results in no files copied", () => {
    const callerSandbox = makeTmpDir();
    const scratchRoot = makeTmpDir();
    copyWorkspace(callerSandbox, scratchRoot, []);
    expect(fs.readdirSync(scratchRoot)).toHaveLength(0);
  });
});

// ── runMeshSpawn ─────────────────────────────────────────────────────────

describe("runMeshSpawn", () => {
  it("returns ok:true with the worker handle and scratchRoot", async () => {
    const callerSandbox = makeTmpDir();
    const handle = makePendingHandle();
    const spawnWorker = vi.fn((_args: SpawnArgs) => handle as WorkerHandle);

    const ctx: MeshSpawnContext = {
      recipe: "mesh-node",
      workerName: "my-node",
      busRoot: "/tmp/bus",
      task: "monitor logs",
      callerSandbox,
      callerName: "authority",
      callerCwd: "/tmp/caller-cwd",
      spawnWorker,
    };

    const result = await runMeshSpawn(ctx);
    expect(result.ok).toBe(true);
    expect(result.workerName).toBe("my-node");
    expect(result.scratchRoot).toBeTruthy();
    expect(fs.existsSync(result.scratchRoot)).toBe(true);
    expect(result.handle).toBe(handle);
    expect(spawnWorker).toHaveBeenCalledOnce();
    fs.rmSync(result.scratchRoot, { recursive: true, force: true });
  });

  it("returns ok:false and cleans up scratchRoot when spawnWorker throws", async () => {
    const callerSandbox = makeTmpDir();
    const spawnWorker = vi.fn((_args: SpawnArgs) => {
      throw new Error("binary not found");
    });

    const ctx: MeshSpawnContext = {
      recipe: "mesh-node",
      workerName: "failing-node",
      busRoot: "/tmp/bus",
      callerSandbox,
      callerName: "authority",
      callerCwd: "/tmp/caller-cwd",
      spawnWorker,
    };

    const result = await runMeshSpawn(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/spawn failed.*binary not found/);
    // scratchRoot should be cleaned up
    expect(fs.existsSync(result.scratchRoot)).toBe(false);
  });

  it("passes the correct habitatOverlay to spawnWorker", async () => {
    const callerSandbox = makeTmpDir();
    let capturedArgs: SpawnArgs | null = null;
    const handle = makePendingHandle();
    const spawnWorker = vi.fn((args: SpawnArgs) => {
      capturedArgs = args;
      return handle as WorkerHandle;
    });

    const ctx: MeshSpawnContext = {
      recipe: "mesh-node",
      workerName: "wired-node",
      busRoot: "/tmp/mybus",
      callerSandbox,
      callerName: "orchestrator",
      callerCwd: "/tmp/caller-cwd",
      spawnWorker,
    };

    await runMeshSpawn(ctx);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.habitatOverlay.supervisor).toBe("orchestrator");
    expect(capturedArgs!.habitatOverlay.submitsWorkTo).toBe("orchestrator");
    expect(capturedArgs!.habitatOverlay.acceptsWorkFrom).toEqual(["orchestrator"]);
    expect(capturedArgs!.habitatOverlay.messagesWith).toEqual(["orchestrator"]);
    expect(capturedArgs!.habitatOverlay.spawns).toEqual([]);
    fs.rmSync(capturedArgs!.scratchRoot, { recursive: true, force: true });
  });

  it("two calls produce different scratchRoot paths", async () => {
    const callerSandbox = makeTmpDir();
    const handles = [makePendingHandle(), makePendingHandle()];
    let i = 0;
    const spawnWorker = vi.fn((_args: SpawnArgs) => handles[i++] as WorkerHandle);

    const makeCtx = (name: string): MeshSpawnContext => ({
      recipe: "mesh-node",
      workerName: name,
      busRoot: "/tmp/bus",
      callerSandbox,
      callerName: "authority",
      spawnWorker,
    });

    const [r1, r2] = await Promise.all([
      runMeshSpawn(makeCtx("n1")),
      runMeshSpawn(makeCtx("n2")),
    ]);
    expect(r1.scratchRoot).not.toBe(r2.scratchRoot);
    fs.rmSync(r1.scratchRoot, { recursive: true, force: true });
    fs.rmSync(r2.scratchRoot, { recursive: true, force: true });
  });

  it("copies workspace files into scratchRoot before spawning", async () => {
    const callerSandbox = makeTmpDir();
    fs.writeFileSync(path.join(callerSandbox, "ref.md"), "reference content");
    let capturedScratch = "";
    const handle = makePendingHandle();
    const spawnWorker = vi.fn((args: SpawnArgs) => {
      capturedScratch = args.scratchRoot;
      return handle as WorkerHandle;
    });

    const ctx: MeshSpawnContext = {
      recipe: "mesh-node",
      workerName: "ws-node",
      busRoot: "/tmp/bus",
      workspace: { include: ["ref.md"] },
      callerSandbox,
      callerName: "authority",
      spawnWorker,
    };

    await runMeshSpawn(ctx);
    expect(fs.existsSync(path.join(capturedScratch, "ref.md"))).toBe(true);
    fs.rmSync(capturedScratch, { recursive: true, force: true });
  });
});

// ── parseRef — ADR-0008 5-form reference grammar ─────────────────────────────

describe("parseRef", () => {
  // ── Literal pass-through ──────────────────────────────────────────────────

  it("literal string (no @) → kind:literal with value", () => {
    const r = parseRef("peer-a");
    expect(r.kind).toBe("literal");
    if (r.kind === "literal") expect(r.value).toBe("peer-a");
  });

  it("literal empty string throws", () => {
    expect(() => parseRef("")).toThrow(/empty/i);
  });

  // ── Form 1: @<group>:<recipe> ─────────────────────────────────────────────

  it("@<group>:<recipe> → kind:group-recipe", () => {
    const r = parseRef("@haiku:writer");
    expect(r.kind).toBe("group-recipe");
    if (r.kind === "group-recipe") {
      expect(r.group).toBe("haiku");
      expect(r.recipe).toBe("writer");
    }
  });

  it("@<group>:<recipe> with multi-word group → kind:group-recipe", () => {
    const r = parseRef("@my-team:reviewer");
    expect(r.kind).toBe("group-recipe");
    if (r.kind === "group-recipe") {
      expect(r.group).toBe("my-team");
      expect(r.recipe).toBe("reviewer");
    }
  });

  // ── Form 2: @<group> ──────────────────────────────────────────────────────

  it("bare @<group> → kind:group (default disambiguation)", () => {
    const r = parseRef("@reviewers");
    expect(r.kind).toBe("group");
    if (r.kind === "group") expect(r.group).toBe("reviewers");
  });

  // ── Form 3: @<recipe> (via classifyBareRef disambiguation) ───────────────

  it("classifyBareRef: token matching recipe but not group → kind:recipe", () => {
    const r = classifyBareRef("writer", ["writer", "reviewer"], []);
    expect(r.kind).toBe("recipe");
    if (r.kind === "recipe") expect(r.recipe).toBe("writer");
  });

  it("classifyBareRef: token matching group but not recipe → kind:group", () => {
    const r = classifyBareRef("haiku", [], ["haiku"]);
    expect(r.kind).toBe("group");
    if (r.kind === "group") expect(r.group).toBe("haiku");
  });

  it("classifyBareRef: token matching BOTH → throws ambiguity error", () => {
    expect(() => classifyBareRef("haiku", ["haiku"], ["haiku"])).toThrow(/ambiguous/i);
  });

  it("classifyBareRef: token matching neither → kind:group (unknown, caught at runtime)", () => {
    const r = classifyBareRef("unknown", [], []);
    expect(r.kind).toBe("group");
  });

  // ── Form 4: @$myGroups ────────────────────────────────────────────────────

  it("@$myGroups → kind:my-groups", () => {
    const r = parseRef("@$myGroups");
    expect(r.kind).toBe("my-groups");
  });

  // ── Form 5: @$myGroups:<recipe> ──────────────────────────────────────────

  it("@$myGroups:<recipe> → kind:my-groups-recipe", () => {
    const r = parseRef("@$myGroups:writer");
    expect(r.kind).toBe("my-groups-recipe");
    if (r.kind === "my-groups-recipe") expect(r.recipe).toBe("writer");
  });

  // ── Malformed cases (must throw) ─────────────────────────────────────────

  it("@ alone throws", () => {
    expect(() => parseRef("@")).toThrow();
  });

  it("whitespace in ref throws", () => {
    expect(() => parseRef("@group name")).toThrow(/whitespace/i);
  });

  it("@<group>:<recipe>:<extra> (multiple colons) throws", () => {
    expect(() => parseRef("@group:recipe:extra")).toThrow(/colon|separator/i);
  });

  it("@<group>: (empty recipe segment) throws", () => {
    expect(() => parseRef("@group:")).toThrow(/empty.*recipe|recipe.*empty/i);
  });

  it("@:<recipe> (empty group segment) throws", () => {
    expect(() => parseRef("@:recipe")).toThrow(/empty.*group|group.*empty/i);
  });

  it("@$unknown throws (unknown symbolic)", () => {
    expect(() => parseRef("@$unknown")).toThrow(/symbolic|unknown/i);
  });

  it("@$spawner throws (unsupported symbolic)", () => {
    expect(() => parseRef("@$spawner")).toThrow(/symbolic|unknown/i);
  });
});

// ── applyEntryWiringToOverlay — Step 0 fix for initial_mesh per-entry wiring ─

describe("applyEntryWiringToOverlay", () => {
  it("returns base overlay unchanged when entryWiring is empty", () => {
    const base = computeWorkerHabitatOverlay("host");
    const result = applyEntryWiringToOverlay(base, {});
    expect(result.supervisor).toBe("host");
    expect(result.submitsWorkTo).toBe("host");
    expect(result.acceptsWorkFrom).toEqual(["host"]);
    expect(result.messagesWith).toEqual(["host"]);
    expect(result.spawns).toEqual([]);
  });

  it("overrides submitsWorkTo when entry declares it", () => {
    const base = computeWorkerHabitatOverlay("host");
    const result = applyEntryWiringToOverlay(base, { submitsWorkTo: "reviewer" });
    expect(result.submitsWorkTo).toBe("reviewer");
    // other fields still defaulted to host
    expect(result.supervisor).toBe("host");
    expect(result.acceptsWorkFrom).toEqual(["host"]);
    expect(result.messagesWith).toEqual(["host"]);
  });

  it("overrides messagesWith when entry declares it", () => {
    const base = computeWorkerHabitatOverlay("host");
    const result = applyEntryWiringToOverlay(base, { messagesWith: ["analyst", "writer"] });
    expect(result.messagesWith).toEqual(["analyst", "writer"]);
    // other fields unchanged
    expect(result.supervisor).toBe("host");
    expect(result.submitsWorkTo).toBe("host");
    expect(result.acceptsWorkFrom).toEqual(["host"]);
  });

  it("overrides acceptsWorkFrom when entry declares it", () => {
    const base = computeWorkerHabitatOverlay("host");
    const result = applyEntryWiringToOverlay(base, { acceptsWorkFrom: ["writer"] });
    expect(result.acceptsWorkFrom).toEqual(["writer"]);
    // supervisor still defaults to host
    expect(result.supervisor).toBe("host");
  });

  it("overrides escalatesTo (supervisor) when entry declares it", () => {
    const base = computeWorkerHabitatOverlay("host");
    const result = applyEntryWiringToOverlay(base, { escalatesTo: "authority" });
    expect(result.supervisor).toBe("authority");
    // other fields unchanged
    expect(result.submitsWorkTo).toBe("host");
    expect(result.acceptsWorkFrom).toEqual(["host"]);
    expect(result.messagesWith).toEqual(["host"]);
  });

  it("all four overrides applied simultaneously produce correct overlay", () => {
    const base = computeWorkerHabitatOverlay("host");
    const result = applyEntryWiringToOverlay(base, {
      escalatesTo: "authority",
      submitsWorkTo: "reviewer",
      acceptsWorkFrom: ["writer"],
      messagesWith: ["analyst", "reviewer"],
    });
    expect(result.supervisor).toBe("authority");
    expect(result.submitsWorkTo).toBe("reviewer");
    expect(result.acceptsWorkFrom).toEqual(["writer"]);
    expect(result.messagesWith).toEqual(["analyst", "reviewer"]);
    expect(result.spawns).toEqual([]); // unaffected
  });

  it("does not mutate the base overlay", () => {
    const base = computeWorkerHabitatOverlay("host");
    applyEntryWiringToOverlay(base, { submitsWorkTo: "reviewer" });
    expect(base.submitsWorkTo).toBe("host");
  });
});

// ── resolveInitialMeshRefs — group expansion for initial_mesh wiring ─────────

describe("resolveInitialMeshRefs", () => {
  function makeIndex(entries: Array<[string, string[]]>): Map<string, string[]> {
    return new Map(entries);
  }

  it("passes literal refs through unchanged", () => {
    const index = makeIndex([["analyst", ["workers"]]]);
    expect(resolveInitialMeshRefs(["analyst"], index)).toEqual(["analyst"]);
  });

  it("expands @group ref to matching peer names", () => {
    const index = makeIndex([
      ["analyst", ["workers"]],
      ["writer", ["workers"]],
      ["reviewer", ["reviewers"]],
    ]);
    const result = resolveInitialMeshRefs(["@workers"], index);
    expect(result).toEqual(["analyst", "writer"]);
  });

  it("expands @group to empty list when no peers match", () => {
    const index = makeIndex([["analyst", ["workers"]]]);
    const result = resolveInitialMeshRefs(["@nobody"], index);
    expect(result).toEqual([]);
  });

  it("deduplicates peers that appear in multiple groups", () => {
    const index = makeIndex([["peer-a", ["group1", "group2"]]]);
    const result = resolveInitialMeshRefs(["@group1", "@group2"], index);
    expect(result).toEqual(["peer-a"]); // only once
  });

  it("mixes literals and group refs", () => {
    const index = makeIndex([
      ["analyst", ["workers"]],
      ["reviewer", ["reviewers"]],
    ]);
    const result = resolveInitialMeshRefs(["reviewer", "@workers"], index);
    expect(result).toEqual(["reviewer", "analyst"]);
  });
});

describe("resolveInitialMeshScalarRef", () => {
  function makeIndex(entries: Array<[string, string[]]>): Map<string, string[]> {
    return new Map(entries);
  }

  it("returns literal ref unchanged", () => {
    const index = makeIndex([]);
    expect(resolveInitialMeshScalarRef("authority", index)).toBe("authority");
  });

  it("returns first matching peer for @group ref", () => {
    const index = makeIndex([
      ["authority", ["authority-group"]],
      ["other", ["other-group"]],
    ]);
    expect(resolveInitialMeshScalarRef("@authority-group", index)).toBe("authority");
  });

  it("returns raw ref when @group matches nothing", () => {
    const index = makeIndex([]);
    expect(resolveInitialMeshScalarRef("@nobody", index)).toBe("@nobody");
  });
});

// ── runMeshSpawn — callerCwd forwarding (issue #172) ─────────────────────────

describe("runMeshSpawn — callerCwd forwarding (issue #172)", () => {
  it("forwards callerCwd to spawnWorker", async () => {
    const callerSandbox = makeTmpDir();
    let capturedArgs: SpawnArgs | null = null;
    const handle = makePendingHandle();
    const spawnWorker = vi.fn((args: SpawnArgs) => {
      capturedArgs = args;
      return handle as WorkerHandle;
    });

    const ctx: MeshSpawnContext = {
      recipe: "mesh-node",
      workerName: "cwd-test-node",
      busRoot: "/tmp/bus",
      callerSandbox,
      callerName: "orchestrator",
      callerCwd: "/tmp/test-cwd",
      spawnWorker,
    };

    const result = await runMeshSpawn(ctx);
    expect(result.ok).toBe(true);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.callerCwd).toBe("/tmp/test-cwd");
    fs.rmSync(result.scratchRoot, { recursive: true, force: true });
  });

  it("passes distinct callerCwd values through unchanged", async () => {
    const callerSandbox = makeTmpDir();
    const cwds: string[] = [];
    const handle = makePendingHandle();
    const spawnWorker = vi.fn((args: SpawnArgs) => {
      cwds.push(args.callerCwd);
      return handle as WorkerHandle;
    });

    const ctx: MeshSpawnContext = {
      recipe: "mesh-node",
      workerName: "cwd-test-node-2",
      busRoot: "/tmp/bus",
      callerSandbox,
      callerName: "orchestrator",
      callerCwd: "/home/user/pi-sandbox",
      spawnWorker,
    };

    const result = await runMeshSpawn(ctx);
    expect(result.ok).toBe(true);
    expect(cwds).toEqual(["/home/user/pi-sandbox"]);
    fs.rmSync(result.scratchRoot, { recursive: true, force: true });
  });
});

// ── serializeHabitatOverlay includes groups ───────────────────────────────

describe("serializeHabitatOverlay — groups field", () => {
  it("includes groups field when overlay has groups set", () => {
    const overlay = { ...computeWorkerHabitatOverlay("boss"), groups: ["haiku"] };
    const json = JSON.parse(serializeHabitatOverlay(overlay));
    expect(json.groups).toEqual(["haiku"]);
  });

  it("omits groups key when overlay has no groups", () => {
    const overlay = computeWorkerHabitatOverlay("boss");
    const json = JSON.parse(serializeHabitatOverlay(overlay));
    expect("groups" in json).toBe(false);
  });
});
