// child-spawn.test.ts — hermetic unit tests for buildRecipeChildArgv and resolvePiBin.
// No I/O, no model calls, no network, no env vars from models.env.

import { describe, it, expect } from "vitest";
import { buildRecipeChildArgv, resolvePiBin } from "./child-spawn.mjs";

const FAKE_PI_BIN = "/fake/bin/pi";

describe("buildRecipeChildArgv — required flags", () => {
  it("begins argv with piBin as the first element", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "deferred-writer",
      sandbox: "/tmp/sandbox",
      busRoot: "/tmp/bus",
      instanceName: "cottontail-writer",
    });
    expect(argv[0]).toBe(FAKE_PI_BIN);
  });

  it("--recipe precedes the recipe name", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "mesh-authority",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "hare-authority",
    });
    const recipeIdx = argv.indexOf("--recipe");
    expect(recipeIdx).toBeGreaterThanOrEqual(0);
    expect(argv[recipeIdx + 1]).toBe("mesh-authority");
    // --recipe must appear before --sandbox
    const sandboxIdx = argv.indexOf("--sandbox");
    expect(recipeIdx).toBeLessThan(sandboxIdx);
  });

  it("includes --sandbox with its value", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/my-sandbox",
      busRoot: "/tmp/b",
      instanceName: "a",
    });
    const idx = argv.indexOf("--sandbox");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("/tmp/my-sandbox");
  });

  it("includes --peer-bus with its value", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/my-bus",
      instanceName: "a",
    });
    const idx = argv.indexOf("--peer-bus");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("/tmp/my-bus");
  });

  it("includes --peer-name with instanceName", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "my-worker",
    });
    const idx = argv.indexOf("--peer-name");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("my-worker");
  });
});

describe("buildRecipeChildArgv — optional flags omitted when unset", () => {
  it("omits --topology-overlay when not provided", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "a",
    });
    expect(argv).not.toContain("--topology-overlay");
  });

  it("omits --task when not provided", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "a",
    });
    expect(argv).not.toContain("--task");
  });

  it("omits --inherit-pty when not provided", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "a",
    });
    expect(argv).not.toContain("--inherit-pty");
  });

  it("omits --debug when not provided", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "a",
    });
    expect(argv).not.toContain("--debug");
  });

  it("omits -p when not provided", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "a",
    });
    expect(argv).not.toContain("-p");
  });
});

describe("buildRecipeChildArgv — optional flags present when set", () => {
  it("includes --topology-overlay with JSON as a single arg", () => {
    const overlay = JSON.stringify({ supervisor: "boss", agents: [] });
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "a",
      topologyOverlay: overlay,
    });
    const idx = argv.indexOf("--topology-overlay");
    expect(idx).toBeGreaterThanOrEqual(0);
    // The JSON is passed as the NEXT single element, not split
    expect(argv[idx + 1]).toBe(overlay);
    // No further element that looks like JSON before the next flag
    expect(argv.indexOf("--topology-overlay")).toBe(idx); // only one occurrence
  });

  it("includes --task with its value", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "a",
      task: "draft hello.txt",
    });
    const idx = argv.indexOf("--task");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("draft hello.txt");
  });

  it("--inherit-pty is a bare flag (no value)", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "a",
      inheritPty: true,
    });
    const idx = argv.indexOf("--inherit-pty");
    expect(idx).toBeGreaterThanOrEqual(0);
    // The next element should NOT be the value for --inherit-pty (it's a bare flag)
    // It should be either another flag or end of array
    const next = argv[idx + 1];
    expect(next === undefined || next.startsWith("-")).toBe(true);
  });

  it("--debug is a bare flag (no value)", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "a",
      debug: true,
    });
    const idx = argv.indexOf("--debug");
    expect(idx).toBeGreaterThanOrEqual(0);
    const next = argv[idx + 1];
    expect(next === undefined || next.startsWith("-")).toBe(true);
  });

  it("includes -p with its prompt value", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "r",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "a",
      printPrompt: "draft two files",
    });
    const idx = argv.indexOf("-p");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("draft two files");
  });
});

describe("buildRecipeChildArgv — stable ordering", () => {
  it("maintains stable ordering: piBin, --recipe, --sandbox, --peer-bus, --peer-name, optionals", () => {
    const argv = buildRecipeChildArgv({
      piBin: FAKE_PI_BIN,
      recipe: "deferred-writer",
      sandbox: "/tmp/s",
      busRoot: "/tmp/b",
      instanceName: "cottontail-writer",
      topologyOverlay: '{"supervisor":"boss"}',
      task: "do something",
      inheritPty: true,
      debug: true,
      printPrompt: "write a file",
    });

    const piBinIdx = argv.indexOf(FAKE_PI_BIN);
    const recipeIdx = argv.indexOf("--recipe");
    const sandboxIdx = argv.indexOf("--sandbox");
    const busIdx = argv.indexOf("--peer-bus");
    const peerNameIdx = argv.indexOf("--peer-name");
    const overlayIdx = argv.indexOf("--topology-overlay");
    const taskIdx = argv.indexOf("--task");
    const inheritPtyIdx = argv.indexOf("--inherit-pty");
    const debugIdx = argv.indexOf("--debug");
    const printIdx = argv.indexOf("-p");

    expect(piBinIdx).toBeLessThan(recipeIdx);
    expect(recipeIdx).toBeLessThan(sandboxIdx);
    expect(sandboxIdx).toBeLessThan(busIdx);
    expect(busIdx).toBeLessThan(peerNameIdx);
    expect(peerNameIdx).toBeLessThan(overlayIdx);
    expect(overlayIdx).toBeLessThan(taskIdx);
    expect(taskIdx).toBeLessThan(inheritPtyIdx);
    expect(inheritPtyIdx).toBeLessThan(debugIdx);
    expect(debugIdx).toBeLessThan(printIdx);
  });
});

describe("resolvePiBin", () => {
  it("resolves pi bin under node_modules/.bin/ relative to repoRoot", () => {
    const bin = resolvePiBin("/some/repo");
    expect(bin).toBe("/some/repo/node_modules/.bin/pi");
  });
});
