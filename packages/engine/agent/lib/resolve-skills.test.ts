// resolve-skills.test.ts — hermetic unit tests for skill resolution.
// No model calls, no network. Uses tmpdir for skill directories.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it, expect } from "vitest";
import { resolveSkills } from "./resolve-skills.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "resolve-skills-test-"));
});

function makeSkillDir(base: string, skillName: string): string {
  const skillDir = path.join(base, skillName);
  mkdirSync(skillDir, { recursive: true });
  return skillDir;
}

describe("resolveSkills", () => {
  it("returns empty array for empty names list", () => {
    expect(resolveSkills([], [])).toEqual([]);
  });

  it("resolves a bare skill name from the first skillDir", () => {
    const dir = path.join(tmpDir, "skills");
    makeSkillDir(dir, "my-skill");
    const result = resolveSkills(["my-skill"], [dir]);
    expect(result).toEqual([path.join(dir, "my-skill")]);
  });

  it("falls through to second skillDir when skill absent from first", () => {
    const dir1 = path.join(tmpDir, "skills1");
    const dir2 = path.join(tmpDir, "skills2");
    mkdirSync(dir1, { recursive: true });
    makeSkillDir(dir2, "fallback-skill");
    const result = resolveSkills(["fallback-skill"], [dir1, dir2]);
    expect(result).toEqual([path.join(dir2, "fallback-skill")]);
  });

  it("project dir wins over bundled when both have the same skill name", () => {
    const projectDir = path.join(tmpDir, "project-skills");
    const bundledDir = path.join(tmpDir, "bundled-skills");
    makeSkillDir(projectDir, "shared-skill");
    makeSkillDir(bundledDir, "shared-skill");
    const result = resolveSkills(["shared-skill"], [projectDir, bundledDir]);
    expect(result).toEqual([path.join(projectDir, "shared-skill")]);
  });

  it("accepts an absolute path verbatim without searching skillDirs", () => {
    const absoluteSkillDir = path.join(tmpDir, "absolute-skill");
    mkdirSync(absoluteSkillDir, { recursive: true });
    const result = resolveSkills([absoluteSkillDir], []);
    expect(result).toEqual([absoluteSkillDir]);
  });

  it("resolves multiple skill names in order", () => {
    const dir = path.join(tmpDir, "multi-skills");
    makeSkillDir(dir, "skill-a");
    makeSkillDir(dir, "skill-b");
    const result = resolveSkills(["skill-a", "skill-b"], [dir]);
    expect(result).toEqual([
      path.join(dir, "skill-a"),
      path.join(dir, "skill-b"),
    ]);
  });

  it("throws a clear error when skill not found in any dir", () => {
    const dir = path.join(tmpDir, "empty-skills");
    mkdirSync(dir, { recursive: true });
    expect(() => resolveSkills(["ghost-skill"], [dir])).toThrowError(
      /ghost-skill.*not found/,
    );
  });

  it("not-found error mentions all searched dirs", () => {
    const dir1 = path.join(tmpDir, "sk1");
    const dir2 = path.join(tmpDir, "sk2");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    let errMsg = "";
    try {
      resolveSkills(["phantom"], [dir1, dir2]);
    } catch (e) {
      errMsg = (e as Error).message;
    }
    expect(errMsg).toContain("sk1");
    expect(errMsg).toContain("sk2");
  });

  it("throws when absolute path does not exist", () => {
    const nonExistent = path.join(tmpDir, "does-not-exist");
    expect(() => resolveSkills([nonExistent], [])).toThrowError(
      /does not exist/,
    );
  });

  it("throws when absolute path is a file, not a directory", () => {
    const filePath = path.join(tmpDir, "not-a-dir.yaml");
    writeFileSync(filePath, "content", "utf8");
    expect(() => resolveSkills([filePath], [])).toThrowError(
      /not a directory/,
    );
  });
});
