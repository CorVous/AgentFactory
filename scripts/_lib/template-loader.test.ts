import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadTemplate } from "./template-loader.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("template-loader", () => {
  let tmpRoot: string;
  let templatesDir: string;
  let extensionsDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "template-loader-"));
    templatesDir = path.join(tmpRoot, "templates");
    extensionsDir = path.join(tmpRoot, "extensions");
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeTemplate(name: string, body: string): void {
    fs.writeFileSync(path.join(templatesDir, `${name}.yaml`), body, "utf8");
  }

  function writeExtension(name: string): void {
    fs.writeFileSync(path.join(extensionsDir, `${name}.ts`), "", "utf8");
  }

  it("happy path: returns the extensions list in declared order", () => {
    writeTemplate("peer", "extensions:\n  - habitat\n  - sandbox\n  - mesh-rail\n");
    writeExtension("habitat");
    writeExtension("sandbox");
    writeExtension("mesh-rail");
    const result = loadTemplate("peer", { templatesDir, extensionsDir });
    expect(result).toEqual(["habitat", "sandbox", "mesh-rail"]);
  });

  it("missing template file throws with template-loader: prefix and the path", () => {
    const expectedPath = path.join(templatesDir, "peer.yaml");
    expect(() => loadTemplate("peer", { templatesDir, extensionsDir })).toThrow(
      /template-loader: template not found/
    );
    expect(() => loadTemplate("peer", { templatesDir, extensionsDir })).toThrow(expectedPath);
  });

  it("missing extension throws naming the extension and the template", () => {
    writeTemplate("peer", "extensions:\n  - habitat\n  - ghost\n");
    writeExtension("habitat");
    expect(() => loadTemplate("peer", { templatesDir, extensionsDir })).toThrow(
      /template-loader: extension 'ghost' listed in .* not found/
    );
  });

  it("malformed YAML throws with the template path", () => {
    writeTemplate("peer", "extensions: [unclosed\n");
    expect(() => loadTemplate("peer", { templatesDir, extensionsDir })).toThrow(
      /template-loader: failed to parse/
    );
  });

  it("empty extensions list returns []", () => {
    writeTemplate("peer", "extensions: []\n");
    const result = loadTemplate("peer", { templatesDir, extensionsDir });
    expect(result).toEqual([]);
  });

  it("missing extensions key throws (different from empty list)", () => {
    writeTemplate("peer", "name: peer\n");
    expect(() => loadTemplate("peer", { templatesDir, extensionsDir })).toThrow(
      /missing 'extensions' list/
    );
  });

  it("non-list extensions value throws", () => {
    writeTemplate("peer", "extensions: foo\n");
    expect(() => loadTemplate("peer", { templatesDir, extensionsDir })).toThrow(
      /'extensions' must be a list/
    );
  });

  it("rejects non-string entries in extensions list", () => {
    writeTemplate("peer", "extensions:\n  - habitat\n  - 42\n");
    writeExtension("habitat");
    expect(() => loadTemplate("peer", { templatesDir, extensionsDir })).toThrow(
      /'extensions\[1\]' must be a non-empty string/
    );
  });

  it("does not return a reference to the parsed YAML's internal array", () => {
    writeTemplate("peer", "extensions:\n  - habitat\n  - sandbox\n");
    writeExtension("habitat");
    writeExtension("sandbox");
    const result = loadTemplate("peer", { templatesDir, extensionsDir });
    result.push("hacked");
    const result2 = loadTemplate("peer", { templatesDir, extensionsDir });
    expect(result2.length).toBe(2);
    expect(result2).not.toContain("hacked");
  });
});
