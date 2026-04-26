// component-policy.test.ts — tests for the parent-side bad-component
// defenses: the component-path allowlist (A) and the static import
// scan (B). Lives under components/__tests__/ to match the existing
// test-runner glob (npm run test:delegate).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkComponentImports,
  checkComponentPath,
  checkComponentPolicy,
} from "../../lib/component-policy.ts";
import type { ParentSide } from "../_parent-side.ts";

const COMPONENTS_DIR = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);

function compPath(basename: string): string {
  return path.join(COMPONENTS_DIR, basename);
}

/* ---------- (A) checkComponentPath ------------------------------------ */

describe("component-policy: checkComponentPath (A)", () => {
  it("accepts cwd-guard.ts (registry-derived)", () => {
    assert.doesNotThrow(() => checkComponentPath(compPath("cwd-guard.ts")));
  });

  it("accepts sandbox-fs.ts (registry-derived)", () => {
    assert.doesNotThrow(() => checkComponentPath(compPath("sandbox-fs.ts")));
  });

  it("accepts each ROLE_COMPONENTS entry", () => {
    for (const name of [
      "stage-write.ts",
      "emit-summary.ts",
      "review.ts",
      "run-deferred-writer.ts",
      "emit-agent-spec.ts",
      "dispatch-agent.ts",
    ]) {
      assert.doesNotThrow(
        () => checkComponentPath(compPath(name)),
        `${name} should be allowlisted`,
      );
    }
  });

  it("rejects paths outside pi-sandbox/.pi/components/", () => {
    assert.throws(
      () => checkComponentPath("/tmp/evil.ts"),
      /not in pi-sandbox\/\.pi\/components/,
    );
  });

  it("rejects paths under the extensions/ directory", () => {
    const extPath = path.resolve(
      COMPONENTS_DIR,
      "..",
      "extensions",
      "deferred-writer.ts",
    );
    assert.throws(
      () => checkComponentPath(extPath),
      /not in pi-sandbox\/\.pi\/components/,
    );
  });

  it("rejects an unknown basename inside the components dir", () => {
    assert.throws(
      () => checkComponentPath(compPath("__not_in_allowlist__.ts")),
      /not in component allowlist/,
    );
  });
});

/* ---------- (B) checkComponentImports --------------------------------- */

describe("component-policy: checkComponentImports (B)", () => {
  it("accepts cwd-guard.ts (privileged for node:fs)", () => {
    assert.doesNotThrow(() => checkComponentImports(compPath("cwd-guard.ts")));
  });

  it("accepts sandbox-fs.ts (privileged for node:fs)", () => {
    assert.doesNotThrow(() => checkComponentImports(compPath("sandbox-fs.ts")));
  });

  it("accepts stage-write.ts (privileged for node:fs)", () => {
    assert.doesNotThrow(() => checkComponentImports(compPath("stage-write.ts")));
  });

  it("accepts emit-agent-spec.ts (privileged for node:fs)", () => {
    assert.doesNotThrow(() =>
      checkComponentImports(compPath("emit-agent-spec.ts")),
    );
  });

  it("accepts dispatch-agent.ts (privileged for node:fs)", () => {
    assert.doesNotThrow(() =>
      checkComponentImports(compPath("dispatch-agent.ts")),
    );
  });

  it("accepts unprivileged components (emit-summary, review, run-deferred-writer)", () => {
    for (const name of ["emit-summary.ts", "review.ts", "run-deferred-writer.ts"]) {
      assert.doesNotThrow(
        () => checkComponentImports(compPath(name)),
        `${name} should pass the import scan`,
      );
    }
  });

  it("rejects a temp-file fixture importing node:fs without privilege", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-policy-"));
    const tmpFile = path.join(tmpDir, "evil.ts");
    fs.writeFileSync(
      tmpFile,
      `import * as fs from "node:fs"; export default function () {}`,
      "utf8",
    );
    try {
      assert.throws(
        () => checkComponentImports(tmpFile),
        /imports forbidden module "node:fs"/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects child_process imports", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-policy-"));
    const tmpFile = path.join(tmpDir, "evil.ts");
    fs.writeFileSync(
      tmpFile,
      `import { spawn } from "node:child_process"; export default function () {}`,
      "utf8",
    );
    try {
      assert.throws(
        () => checkComponentImports(tmpFile),
        /imports forbidden module "node:child_process"/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects dynamic require() of a forbidden module", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-policy-"));
    const tmpFile = path.join(tmpDir, "evil.ts");
    fs.writeFileSync(
      tmpFile,
      `const fs = require("fs"); export default function () {}`,
      "utf8",
    );
    try {
      assert.throws(
        () => checkComponentImports(tmpFile),
        /imports forbidden module "fs"/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/* ---------- checkComponentPolicy (the runner used by auto-inject) ----- */

describe("component-policy: checkComponentPolicy", () => {
  it("accepts a list of well-formed components", () => {
    const components: ParentSide<unknown, unknown>[] = [
      {
        name: "cwd-guard",
        tools: [],
        spawnArgs: ["-e", compPath("cwd-guard.ts")],
        env: () => ({}),
        initialState: () => ({}),
        harvest: () => {},
        finalize: () => ({}),
      },
      {
        name: "stage-write",
        tools: ["stage_write"],
        spawnArgs: ["-e", compPath("stage-write.ts")],
        env: () => ({}),
        initialState: () => ({}),
        harvest: () => {},
        finalize: () => ({}),
      },
    ];
    assert.doesNotThrow(() => checkComponentPolicy(components));
  });

  it("rejects a list with one bad path among good ones", () => {
    const components: ParentSide<unknown, unknown>[] = [
      {
        name: "cwd-guard",
        tools: [],
        spawnArgs: ["-e", compPath("cwd-guard.ts")],
        env: () => ({}),
        initialState: () => ({}),
        harvest: () => {},
        finalize: () => ({}),
      },
      {
        name: "rogue",
        tools: [],
        spawnArgs: ["-e", "/tmp/rogue.ts"],
        env: () => ({}),
        initialState: () => ({}),
        harvest: () => {},
        finalize: () => ({}),
      },
    ];
    assert.throws(
      () => checkComponentPolicy(components),
      /not in pi-sandbox\/\.pi\/components/,
    );
  });
});
