import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  COMPONENTS,
  forbiddenToolHits,
  isKnownComponent,
  type ComponentName,
} from "../lib/component-spec.ts";
import { findSpawnInvocations } from "../lib/artifact.ts";
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
      const c = spawn("pi", ["-e", "cwd-guard.ts", "--tools", "sandbox_write,bash,ls", "--no-extensions", "-p", "x"]);
    `;
    const spawns = findSpawnInvocations(src);
    assert.deepEqual(forbiddenToolHits(spawns), ["bash"]);
  });
  it("returns empty for safe allowlists", () => {
    const src = `
      const c = spawn("pi", ["-e", "cwd-guard.ts", "--tools", "sandbox_write,sandbox_edit,ls,read", "--no-extensions", "-p", "x"]);
    `;
    const spawns = findSpawnInvocations(src);
    assert.deepEqual(forbiddenToolHits(spawns), []);
  });
});

/* -------- Per-component wiringChecks -------------------------------- */

const FAKE_BLOB_DRAFTER_APPROVAL = `
  const STAGE_WRITE = "/abs/components/stage-write.ts";
  const CWD_GUARD = "/abs/components/cwd-guard.ts";
  spawn("pi", ["-e", CWD_GUARD, "-e", STAGE_WRITE, "--mode", "json", "--tools", "stage_write,ls", "--no-extensions", "-p", "x"], { env: { PI_SANDBOX_ROOT: r } });
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
  spawn("pi", ["-e", CWD_GUARD, "-e", REVIEW, "--mode", "rpc", "--tools", "review,run_deferred_writer", "--no-extensions", "-p", "x"], { env: { PI_SANDBOX_ROOT: r } });
  // tool_execution_start handling for review
  if (event.toolName === "review") verdicts.push(event.args);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
`;

const FAKE_BLOB_EMIT_ONLY = `
  const EMIT = "/abs/components/emit-summary.ts";
  spawn("pi", ["-e", EMIT, "--mode", "json", "--tools", "emit_summary,ls,read,grep,glob", "--no-extensions", "-p", "x"]);
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
    const marks = COMPONENTS["cwd-guard"].wiringChecks({ art, spawns, components });
    assert.ok(marks.every((m) => m.status === "pass"), JSON.stringify(marks));
  });
});

describe("wiringChecks: stage-write", () => {
  it("requires ctx.ui.confirm when review ∉ components", () => {
    const art = makeArt(FAKE_BLOB_DRAFTER_APPROVAL);
    const spawns = findSpawnInvocations(FAKE_BLOB_DRAFTER_APPROVAL);
    const components = new Set<ComponentName>(["cwd-guard", "stage-write"]);
    const marks = COMPONENTS["stage-write"].wiringChecks({ art, spawns, components });
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
    const marks = COMPONENTS["stage-write"].wiringChecks({ art, spawns, components });
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
    const marks = COMPONENTS["emit-summary"].wiringChecks({
      art,
      spawns,
      components,
    });
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
    const marks = COMPONENTS["emit-summary"].wiringChecks({
      art,
      spawns,
      components,
    });
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
    const marks = COMPONENTS["review"].wiringChecks({ art, spawns, components });
    assert.ok(marks.every((m) => m.status === "pass"), JSON.stringify(marks));
  });
});
