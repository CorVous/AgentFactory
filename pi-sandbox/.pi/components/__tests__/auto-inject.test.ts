// auto-inject.test.ts — tests for the augmentation logic shared by
// delegate() and yaml-agent-runner. Verifies that POLICIES is always
// prepended, TOOL_PROVIDERS activate iff their tokens appear, and that
// caller-supplied components colliding with auto-injected names are
// rejected.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  augmentComponents,
  reservedComponentNames,
} from "../../lib/auto-inject.ts";
import type { ParentSide } from "../_parent-side.ts";

function makeStubComponent(name: string, tools: string[]): ParentSide<unknown, unknown> {
  return {
    name,
    tools,
    spawnArgs: [],
    env: () => ({}),
    initialState: () => ({}),
    harvest: () => {},
    finalize: () => ({}),
  };
}

describe("auto-inject: augmentComponents", () => {
  it("prepends cwd-guard (POLICIES) on every spawn", () => {
    const stage = makeStubComponent("stage-write", ["stage_write"]);
    const out = augmentComponents([stage], new Set(["stage_write"]));
    const names = out.map((c) => c.name);
    assert.ok(names.includes("cwd-guard"), "cwd-guard should be prepended");
    assert.ok(names.includes("stage-write"));
  });

  it("activates sandbox-fs when a sandbox_* verb is in toolTokens", () => {
    const stage = makeStubComponent("stage-write", ["stage_write"]);
    const out = augmentComponents(
      [stage],
      new Set(["stage_write", "sandbox_ls"]),
    );
    const names = out.map((c) => c.name);
    assert.ok(names.includes("sandbox-fs"));
    const sb = out.find((c) => c.name === "sandbox-fs")!;
    assert.deepEqual([...sb.tools], ["sandbox_ls"]);
  });

  it("does NOT activate sandbox-fs when no sandbox_* token is present", () => {
    const stage = makeStubComponent("stage-write", ["stage_write"]);
    const out = augmentComponents([stage], new Set(["stage_write"]));
    const names = out.map((c) => c.name);
    assert.ok(!names.includes("sandbox-fs"));
  });

  it("auto-injected components precede user components in load order", () => {
    const stage = makeStubComponent("stage-write", ["stage_write"]);
    const out = augmentComponents([stage], new Set(["stage_write"]));
    const cwdIdx = out.findIndex((c) => c.name === "cwd-guard");
    const stageIdx = out.findIndex((c) => c.name === "stage-write");
    assert.ok(cwdIdx < stageIdx, "cwd-guard must load before user components");
  });

  it("rejects user components colliding with reserved names", () => {
    const fakeCwdGuard = makeStubComponent("cwd-guard", []);
    assert.throws(
      () => augmentComponents([fakeCwdGuard], new Set()),
      /auto-injected; do not list/,
    );
  });

  it("rejects user components colliding with sandbox-fs", () => {
    const fakeSandbox = makeStubComponent("sandbox-fs", ["sandbox_ls"]);
    assert.throws(
      () => augmentComponents([fakeSandbox], new Set(["sandbox_ls"])),
      /auto-injected; do not list/,
    );
  });
});

describe("auto-inject: reservedComponentNames", () => {
  it("includes both cwd-guard and sandbox-fs", () => {
    const reserved = reservedComponentNames();
    assert.ok(reserved.has("cwd-guard"));
    assert.ok(reserved.has("sandbox-fs"));
  });
});
