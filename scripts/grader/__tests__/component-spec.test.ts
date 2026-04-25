import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  COMPONENTS,
  forbiddenToolHits,
  isKnownComponent,
  type ComponentName,
} from "../lib/component-spec.ts";
import {
  findDelegateUsage,
  findSpawnInvocations,
  type ArtifactSet,
  type SpawnInvocation,
} from "../lib/artifact.ts";
import { inferComposition } from "../lib/test-spec.ts";

/* -------- Composition inference cascade ----------------------------- */

describe("inferComposition", () => {
  it("routes run-deferred-writer to rpc-delegator", () => {
    assert.equal(
      inferComposition([
        "cwd-guard",
        "stage-write",
        "review",
        "run-deferred-writer",
      ]),
      "rpc-delegator-over-concurrent-drafters",
    );
  });

  it("routes review-without-fanout to rpc-delegator (review branch precedes brief branch)", () => {
    // The cascade ordering matters: a [cwd-guard, stage-write, review]
    // set is single-drafter LLM-gated, RPC-shaped — not
    // sequential-phases-with-brief.
    assert.equal(
      inferComposition(["cwd-guard", "stage-write", "review"]),
      "rpc-delegator-over-concurrent-drafters",
    );
  });

  it("routes emit-summary + stage-write to sequential-phases-with-brief", () => {
    assert.equal(
      inferComposition(["cwd-guard", "emit-summary", "stage-write"]),
      "sequential-phases-with-brief",
    );
  });

  it("routes single-component sets to single-spawn", () => {
    assert.equal(inferComposition(["emit-summary"]), "single-spawn");
    assert.equal(inferComposition(["cwd-guard"]), "single-spawn");
    assert.equal(
      inferComposition(["cwd-guard", "stage-write"]),
      "single-spawn",
    );
  });
});

/* -------- isKnownComponent ----------------------------------------- */

describe("isKnownComponent", () => {
  it("accepts the five canonical names", () => {
    for (const n of [
      "cwd-guard",
      "stage-write",
      "emit-summary",
      "review",
      "run-deferred-writer",
    ]) {
      assert.ok(isKnownComponent(n), `${n} should be a known component`);
    }
  });
  it("rejects unknown names", () => {
    assert.equal(isKnownComponent("not-a-component"), false);
    assert.equal(isKnownComponent("stage_write"), false);
  });
});

/* -------- forbiddenToolHits ---------------------------------------- */

describe("forbiddenToolHits", () => {
  it("flags write/edit/bash in any spawn", () => {
    const src = `
      const c = spawn("pi", ["-e", "cwd-guard.ts", "--tools", "sandbox_write,bash,sandbox_ls", "--no-extensions", "-p", "x"]);
    `;
    const spawns = findSpawnInvocations(src);
    assert.deepEqual(forbiddenToolHits(spawns), ["bash"]);
  });
  it("flags built-in fs verbs (read/ls/grep/glob)", () => {
    const src = `
      const c = spawn("pi", ["-e", "cwd-guard.ts", "--tools", "sandbox_write,read,ls,grep,glob", "--no-extensions", "-p", "x"]);
    `;
    const spawns = findSpawnInvocations(src);
    assert.deepEqual(forbiddenToolHits(spawns).sort(), ["glob", "grep", "ls", "read"]);
  });
  it("returns empty for safe allowlists", () => {
    const src = `
      const c = spawn("pi", ["-e", "cwd-guard.ts", "--tools", "sandbox_write,sandbox_edit,sandbox_ls,sandbox_read", "--no-extensions", "-p", "x"]);
    `;
    const spawns = findSpawnInvocations(src);
    assert.deepEqual(forbiddenToolHits(spawns), []);
  });
});

/* -------- Per-component wiringChecks -------------------------------- */

/** Build a WiringContext for tests. `delegateHandles` and
 *  `importedComponents` default to empty sets because these tests
 *  cover the pre-Phase-2.5 inline-spawn pattern; Phase-2.5 adds
 *  dedicated delegate-shape tests separately. */
function ctx(
  art: ArtifactSet,
  spawns: SpawnInvocation[],
  components: Set<ComponentName>,
  overrides: Partial<{
    delegateHandles: Set<ComponentName>;
    importedComponents: Set<ComponentName>;
  }> = {},
) {
  return {
    art,
    spawns,
    components,
    delegateHandles: overrides.delegateHandles ?? new Set<ComponentName>(),
    importedComponents: overrides.importedComponents ?? new Set<ComponentName>(),
  };
}

const FAKE_BLOB_DRAFTER_APPROVAL = `
  const STAGE_WRITE = "/abs/components/stage-write.ts";
  const CWD_GUARD = "/abs/components/cwd-guard.ts";
  spawn("pi", ["-e", CWD_GUARD, "-e", STAGE_WRITE, "--mode", "json", "--tools", "stage_write,sandbox_ls", "--no-extensions", "-p", "x"], { env: { PI_SANDBOX_ROOT: r, PI_SANDBOX_VERBS: "sandbox_ls" } });
  // tool_execution_start handling
  if (event.toolName === "stage_write") staged.push(event.args);
  ctx.ui.confirm("promote?");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  createHash("sha256").update(content);
`;

const FAKE_BLOB_REVIEW_GATED = `
  const STAGE_WRITE = "/abs/components/stage-write.ts";
  const CWD_GUARD = "/abs/components/cwd-guard.ts";
  const REVIEW = "/abs/components/review.ts";
  spawn("pi", ["-e", CWD_GUARD, "-e", REVIEW, "--mode", "rpc", "--tools", "review,run_deferred_writer", "--no-extensions", "-p", "x"], { env: { PI_SANDBOX_ROOT: r, PI_SANDBOX_VERBS: "sandbox_ls" } });
  // tool_execution_start handling for review
  if (event.toolName === "review") verdicts.push(event.args);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
`;

const FAKE_BLOB_EMIT_ONLY = `
  const CWD_GUARD = "/abs/components/cwd-guard.ts";
  const EMIT = "/abs/components/emit-summary.ts";
  spawn("pi", ["-e", CWD_GUARD, "-e", EMIT, "--mode", "json", "--tools", "emit_summary,sandbox_ls,sandbox_read,sandbox_grep,sandbox_glob", "--no-extensions", "-p", "x"], { env: { PI_SANDBOX_ROOT: r, PI_SANDBOX_VERBS: "sandbox_ls,sandbox_read,sandbox_grep,sandbox_glob" } });
  if (event.type === "tool_execution_start" && event.toolName === "emit_summary") {
    const safe = body.slice(0, 16384);
    summaries.push({ title: args.title, body: safe });
  }
  Buffer.byteLength(joined, "utf8");
`;

function makeArt(blob: string) {
  return {
    extensions: ["fake.ts"],
    childTools: [],
    strays: [],
    all: ["fake.ts"],
    extBlob: blob.replace(/\s+/g, " "),
    allBlob: blob.replace(/\s+/g, " "),
    layoutOk: true,
    layoutNotes: [],
  };
}

describe("wiringChecks: cwd-guard", () => {
  it("passes when PI_SANDBOX_ROOT and -e cwd-guard.ts present", () => {
    const art = makeArt(FAKE_BLOB_DRAFTER_APPROVAL);
    const spawns = findSpawnInvocations(FAKE_BLOB_DRAFTER_APPROVAL);
    const components = new Set<ComponentName>(["cwd-guard", "stage-write"]);
    const marks = COMPONENTS["cwd-guard"].wiringChecks(ctx(art, spawns, components));
    assert.ok(marks.every((m) => m.status === "pass"), JSON.stringify(marks));
  });
});

describe("wiringChecks: stage-write", () => {
  it("requires ctx.ui.confirm when review ∉ components", () => {
    const art = makeArt(FAKE_BLOB_DRAFTER_APPROVAL);
    const spawns = findSpawnInvocations(FAKE_BLOB_DRAFTER_APPROVAL);
    const components = new Set<ComponentName>(["cwd-guard", "stage-write"]);
    const marks = COMPONENTS["stage-write"].wiringChecks(ctx(art, spawns, components));
    const confirmMark = marks.find((m) =>
      m.name.includes("ctx.ui.confirm before disk write"),
    );
    assert.ok(confirmMark);
    assert.equal(confirmMark!.status, "pass");
  });

  it("forbids ctx.ui.confirm when review ∈ components", () => {
    // Synthetic: stage-write present, review present, AND ctx.ui.confirm
    // present — should fail the review-mode gate.
    const blob = FAKE_BLOB_DRAFTER_APPROVAL; // has confirm
    const art = makeArt(blob);
    const spawns = findSpawnInvocations(blob);
    const components = new Set<ComponentName>([
      "cwd-guard",
      "stage-write",
      "review",
    ]);
    const marks = COMPONENTS["stage-write"].wiringChecks(ctx(art, spawns, components));
    const noConfirmMark = marks.find((m) =>
      m.name.includes("no ctx.ui.confirm when review"),
    );
    assert.ok(noConfirmMark);
    assert.equal(noConfirmMark!.status, "fail");
  });
});

describe("wiringChecks: emit-summary", () => {
  it("flags ctx.ui.confirm in summary-only flows", () => {
    const blobWithConfirm = FAKE_BLOB_EMIT_ONLY + " ctx.ui.confirm('?')";
    const art = makeArt(blobWithConfirm);
    const spawns = findSpawnInvocations(blobWithConfirm);
    const components = new Set<ComponentName>(["emit-summary"]);
    const marks = COMPONENTS["emit-summary"].wiringChecks(ctx(art, spawns, components));
    const noConfirmMark = marks.find((m) =>
      m.name.includes("no ctx.ui.confirm in summary-only flow"),
    );
    assert.ok(noConfirmMark);
    assert.equal(noConfirmMark!.status, "fail");
  });

  it("passes with bounded body and no confirm", () => {
    const art = makeArt(FAKE_BLOB_EMIT_ONLY);
    const spawns = findSpawnInvocations(FAKE_BLOB_EMIT_ONLY);
    const components = new Set<ComponentName>(["emit-summary"]);
    const marks = COMPONENTS["emit-summary"].wiringChecks(ctx(art, spawns, components));
    assert.ok(marks.every((m) => m.status === "pass"), JSON.stringify(marks));
  });
});

describe("wiringChecks: review", () => {
  it("requires --mode rpc and review in tools", () => {
    const art = makeArt(FAKE_BLOB_REVIEW_GATED);
    const spawns = findSpawnInvocations(FAKE_BLOB_REVIEW_GATED);
    const components = new Set<ComponentName>([
      "cwd-guard",
      "stage-write",
      "review",
    ]);
    const marks = COMPONENTS["review"].wiringChecks(ctx(art, spawns, components));
    assert.ok(marks.every((m) => m.status === "pass"), JSON.stringify(marks));
  });
});

/* -------- findDelegateUsage (Phase 2.5) ----------------------------- */

// Thin-agent fixtures after the auto-injection split: cwd-guard and
// sandbox-fs are NOT imported or referenced — the runner injects them.
// Each user-listed component (stage-write, etc.) appears via the
// `parentSide as X` import alias and shows up in the delegate()
// call's `components` array.
const THIN_AGENT_BLOB = `
  import path from "node:path";
  import { parentSide as STAGE_WRITE } from "../components/stage-write.ts";
  import { delegate } from "../lib/delegate.ts";
  pi.registerCommand("x", {
    handler: async (args, ctx) => {
      await delegate(ctx, {
        components: [STAGE_WRITE],
        extraTools: ["sandbox_ls"],
        prompt: "p",
      });
    },
  });
`;

const INLINE_AGENT_BLOB = `
  const child = spawn("pi", ["-e", "cwd-guard.ts", "--tools", "sandbox_write", "--no-extensions"]);
`;

const ORCHESTRATOR_BLOB = `
  import { cwdGuardSide } from "../components/cwd-guard.ts";
  import { parentSide as STAGE_WRITE } from "../components/stage-write.ts";
  import { parentSide as REVIEW } from "../components/review.ts";
  import { parentSide as RUN_DEFERRED_WRITER } from "../components/run-deferred-writer.ts";
  import { delegate } from "../lib/delegate.ts";
  const stageHook = { ...STAGE_WRITE, harvest() {} };
  const result = await delegate(ctx, { components: [stageHook], extraTools: ["sandbox_ls"], prompt: p });
  REVIEW.harvest(ev, reviewState);
  RUN_DEFERRED_WRITER.harvest(ev, dispatchState);
  spawn("pi", ["--mode", "rpc", ...cwdGuardSide.spawnArgs, "--tools", "run_deferred_writer,review"]);
`;

describe("findDelegateUsage", () => {
  it("detects a thin-agent pattern", () => {
    const u = findDelegateUsage(THIN_AGENT_BLOB);
    assert.equal(u.usesDelegate, true);
    // Extension imports only stage-write directly; cwd-guard and
    // sandbox-fs are auto-injected and never appear as imports.
    assert.deepEqual([...u.importedComponents].sort(), ["stage-write"]);
    // delegateHandles always includes the auto-injected pair when
    // delegate() is used, plus any explicitly-listed components.
    assert.deepEqual(
      [...u.delegateHandles].sort(),
      ["cwd-guard", "sandbox-fs", "stage-write"],
    );
  });

  it("reports usesDelegate=false for an inline-spawn agent", () => {
    const u = findDelegateUsage(INLINE_AGENT_BLOB);
    assert.equal(u.usesDelegate, false);
    assert.equal(u.importedComponents.size, 0);
    assert.equal(u.delegateHandles.size, 0);
  });

  it("resolves a wrapped-component identifier (stageHook) to its underlying import", () => {
    const u = findDelegateUsage(ORCHESTRATOR_BLOB);
    assert.equal(u.usesDelegate, true);
    // stageHook wraps STAGE_WRITE — should be picked up via the wrapper scan.
    assert.ok(u.delegateHandles.has("stage-write"), [...u.delegateHandles].join(","));
    // cwd-guard and sandbox-fs are auto-injected, so they're always in
    // delegateHandles when usesDelegate.
    assert.ok(u.delegateHandles.has("cwd-guard"));
    assert.ok(u.delegateHandles.has("sandbox-fs"));
    // The orchestrator imports cwd-guard's parentSide directly to drive
    // the RPC delegator spawn; that counts as importedComponents but not
    // delegateHandles per se (auto-injection covers that).
    assert.ok(u.importedComponents.has("cwd-guard"));
    // review and run-deferred-writer are imported (for their harvesters)
    // but drive the RPC spawn inline — not in delegateHandles.
    assert.ok(u.importedComponents.has("review"));
    assert.ok(u.importedComponents.has("run-deferred-writer"));
    assert.ok(!u.delegateHandles.has("review"));
    assert.ok(!u.delegateHandles.has("run-deferred-writer"));
  });
});

describe("wiringChecks + delegate (Phase 2.5)", () => {
  it("cwd-guard short-circuits to pass when handled by delegate", () => {
    const art = makeArt("import ... // no PI_SANDBOX_ROOT, no -e literals");
    const marks = COMPONENTS["cwd-guard"].wiringChecks(
      ctx(art, [], new Set(["cwd-guard"]), {
        delegateHandles: new Set(["cwd-guard"]),
        importedComponents: new Set(["cwd-guard"]),
      }),
    );
    assert.ok(marks.every((m) => m.status === "pass"));
    assert.ok(marks.some((m) => m.name.includes("delegate()")));
  });

  it("stage-write short-circuits to pass when handled by delegate", () => {
    const art = makeArt("// thin agent — no ctx.ui.confirm, no fs.writeFileSync");
    const marks = COMPONENTS["stage-write"].wiringChecks(
      ctx(art, [], new Set(["stage-write"]), {
        delegateHandles: new Set(["stage-write"]),
        importedComponents: new Set(["stage-write"]),
      }),
    );
    assert.ok(marks.every((m) => m.status === "pass"));
    assert.ok(marks.some((m) => m.name.includes("delegate()")));
  });

  it("review accepts imported parentSide harvest (no inline literal)", () => {
    const blob = `
      spawn("pi", ["--mode", "rpc", "--tools", "review"]);
      REVIEW.harvest(ev, reviewState);
    `;
    const art = makeArt(blob);
    const spawns = findSpawnInvocations(blob);
    const marks = COMPONENTS["review"].wiringChecks(
      ctx(art, spawns, new Set(["review"]), {
        importedComponents: new Set(["review"]),
      }),
    );
    assert.ok(marks.every((m) => m.status === "pass"), JSON.stringify(marks));
  });
});
