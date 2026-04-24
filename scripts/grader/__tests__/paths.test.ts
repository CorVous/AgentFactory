import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { FRAMEWORK_ROOT, REPO_ROOT } from "../lib/paths.ts";

describe("paths", () => {
  it("REPO_ROOT points at the AgentFactory checkout", () => {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, "pi-sandbox")),
      `REPO_ROOT (${REPO_ROOT}) is missing pi-sandbox/ — constant resolves above the repo`,
    );
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "models.env")));
  });

  it("FRAMEWORK_ROOT points at scripts/", () => {
    assert.ok(
      fs.existsSync(path.join(FRAMEWORK_ROOT, "task-runner", "tasks")),
      `FRAMEWORK_ROOT (${FRAMEWORK_ROOT}) is missing task-runner/tasks — constant does not resolve to scripts/`,
    );
  });
});
