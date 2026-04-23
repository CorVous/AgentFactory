import fs from "node:fs";
import path from "node:path";
import {
  discoverArtifacts,
  extractCommandName,
  findSpawnInvocations,
  type ArtifactSet,
  type SpawnInvocation,
} from "../lib/artifact.ts";
import {
  gradeNdjsonParsing,
  gradeNegativeAnchors,
  gradePathValidation,
  gradeRegisterToolShape,
  gradeRegistration,
  gradeSubprocessRails,
} from "../lib/core-rails.ts";
import { loadPatternSpec, type PatternName, type PatternSpec } from "../lib/pattern-spec.ts";
import { runBehavioralProbe, runLoadProbe, type ProbeContext } from "../lib/probes.ts";
import { Rubric } from "../lib/rubric.ts";
import type { TestSpec } from "../lib/test-spec.ts";

export interface AssemblerGraderArgs {
  repoRoot: string;
  logDir: string;
  model: string;
  task: string;
  spec: TestSpec;
}

export interface AssemblerGraderResult {
  rubric: Rubric;
  kind: "assembly" | "gap";
  pattern?: string;
}

export function gradeAssemblerTask(args: AssemblerGraderArgs): AssemblerGraderResult {
  const { spec } = args;
  const rubric = new Rubric();

  rubric.say(`# Grade — ${args.model}`);
  rubric.say("");
  rubric.say(`Task: \`${args.task}\` · skill: \`${spec.skill}\``);
  rubric.say("");

  if (spec.expectation.kind === "gap") {
    gradeGap(rubric, args);
    return { rubric, kind: "gap" };
  }
  const patternName = spec.expectation.pattern;
  const pattern = loadPatternSpec(args.repoRoot, patternName);
  gradeAssembly(rubric, args, pattern);
  return { rubric, kind: "assembly", pattern: patternName };
}

/* -------------------- GAP case -------------------------------------- */

function gradeGap(rubric: Rubric, args: AssemblerGraderArgs): void {
  rubric.say("## Expected: GAP flag");
  const art = discoverArtifacts(args.logDir);
  const artifactCount = art.extensions.length + art.childTools.length;
  rubric.p0(
    "no artifacts produced (GAP case)",
    artifactCount === 0 ? "pass" : "fail",
    artifactCount === 0 ? undefined : `found ${artifactCount} file(s)`,
  );

  const eventsPath = path.join(args.logDir, "events.ndjson");
  if (!fs.existsSync(eventsPath)) {
    rubric.p0("GAP marker present in events.ndjson", "fail", "events.ndjson missing");
    return;
  }
  const events = fs.readFileSync(eventsPath, "utf8");
  const hasGapMarker = /"GAP:/.test(events) || /GAP: I don't have a component/.test(events);
  rubric.p0(
    "GAP marker present in events.ndjson",
    hasGapMarker ? "pass" : "fail",
    hasGapMarker ? undefined : "no 'GAP:' string in event stream",
  );
}

/* -------------------- Assembly case --------------------------------- */

function gradeAssembly(rubric: Rubric, args: AssemblerGraderArgs, pattern: PatternSpec): void {
  rubric.say(`## Expected: pattern \`${pattern.name}\``);
  rubric.say(`- components: ${pattern.components.join(", ") || "(none)"}`);
  rubric.say(`- tools: ${pattern.tools.join(",")}`);
  rubric.say(`- mode: ${pattern.mode} · tier: \$${pattern.tier}`);
  rubric.say("");

  const art = discoverArtifacts(args.logDir, (_p, src) => classifyAssemblerStray(src, pattern.name));
  emitArtifactHeader(rubric, art, args.logDir);

  if (art.extensions.length === 0 && art.childTools.length === 0) {
    rubric.p0("at least one .ts artifact produced", "fail", "no output");
    return;
  }

  // Structural + layout
  rubric.say("## Structural");
  rubric.p0(
    "Extension file produced",
    art.extensions.length >= 1 ? "pass" : "fail",
    art.extensions.length >= 1 ? undefined : "no extension",
  );
  rubric.p0(
    "files placed at canonical .pi/extensions path",
    art.layoutOk && art.extensions.length > 0 ? "pass" : "fail",
    art.layoutOk ? undefined : art.layoutNotes.join("; "),
  );

  const cmdName = extractCommandName(art.extensions);
  const spawns = art.extensions.flatMap((f) => findSpawnInvocations(fs.readFileSync(f, "utf8")));

  gradeRegistration(rubric, art, cmdName);
  gradeRegisterToolShape(rubric, art);
  gradeSubprocessRails(rubric, art, spawns);
  gradeNdjsonParsing(rubric, art);

  // Pattern-fidelity — the composable part.
  gradePatternFidelity(rubric, pattern, spawns, args.spec);

  // Per-pattern semantic checks.
  applyPerPatternChecks(rubric, pattern.name as PatternName, art, spawns);

  gradeNegativeAnchors(rubric, art);

  // Probes
  if (!process.env.TASK_MODEL && !process.env.SKIP_LOAD) {
    rubric.say("## Load smoke");
    rubric.loadStatus = "skip";
    rubric.loadNote = "TASK_MODEL unset";
    rubric.say("- [-] skipped (TASK_MODEL unset)");
  } else {
    const ctx: ProbeContext = {
      repoRoot: args.repoRoot,
      logDir: args.logDir,
      cmdName,
      taskModel: process.env.TASK_MODEL ?? "anthropic/claude-haiku-4.5",
      probeArgs: args.spec.probe?.args ?? "",
      evidenceAnchor: args.spec.probe?.evidence_anchor,
    };
    runLoadProbe(rubric, ctx, art);
    const mode: "recon" | "writer" = pattern.name === "recon" ? "recon" : "writer";
    runBehavioralProbe(rubric, ctx, mode);
  }
}

function classifyAssemblerStray(src: string, pattern: string): "ext" | "child" | "ignore" {
  if (/registerCommand/.test(src)) return "ext";
  // Assembler patterns don't produce child-tool files — components live in
  // pi-sandbox/.pi/components/ and are referenced, not re-emitted. Any
  // stray that registers a tool is a smell (the model re-implemented a
  // component). Flag but classify as child for the layout check.
  if (/registerTool/.test(src) && /stage_write|emit_summary|sandbox_write|review\b/.test(src)) {
    return "child";
  }
  return "ignore";
}

function emitArtifactHeader(rubric: Rubric, art: ArtifactSet, logDir: string): void {
  const artRoot = path.join(logDir, "artifacts");
  rubric.say("Artifacts:");
  rubric.say(`- extensions (+promoted strays): ${art.extensions.length} file(s)`);
  for (const f of art.extensions) rubric.say(`  - ${path.relative(artRoot, f)}`);
  rubric.say(`- child-tools (+promoted strays): ${art.childTools.length} file(s)`);
  for (const f of art.childTools) rubric.say(`  - ${path.relative(artRoot, f)}`);
  if (!art.layoutOk) {
    rubric.say("- layout issues:");
    for (const note of art.layoutNotes) rubric.say(`  - ${note}`);
  }
  rubric.say("");
}

/* -------------------- Pattern fidelity -------------------------------- */

function gradePatternFidelity(
  rubric: Rubric,
  pattern: PatternSpec,
  spawns: SpawnInvocation[],
  spec: TestSpec,
): void {
  rubric.say(`## Pattern fidelity — \`${pattern.name}\``);
  if (spawns.length === 0) {
    rubric.p0("at least one spawn('pi', [...]) call", "fail", "no spawn found");
    return;
  }
  rubric.p0("at least one spawn('pi', [...]) call", "pass");

  // Expected components — parsed from pattern.md ## Parts plus any
  // extra_components the test spec declares.
  const expectedComponents = new Set(pattern.components);
  if (spec.expectation.kind === "assembly") {
    for (const extra of spec.expectation.extra_components ?? []) expectedComponents.add(extra);
  }

  const loadedComponents = new Set<string>();
  for (const s of spawns) for (const c of s.eFlagComponents) loadedComponents.add(c);

  const missing = [...expectedComponents].filter((c) => !loadedComponents.has(c));
  const extra = [...loadedComponents].filter((c) => {
    if (expectedComponents.has(c)) return false;
    // Scout-then-draft has two sets of components across two spawns; the
    // parser flattens them. A drafter-phase cwd-guard on a recon-only
    // pattern still shows as "extra", which is correct.
    return c.endsWith(".ts") && c !== pattern.path;
  });

  if (missing.length === 0) {
    rubric.p0(
      `components loaded via -e match pattern ## Parts`,
      "pass",
      `[${[...expectedComponents].join(", ")}]`,
    );
  } else {
    rubric.p0(
      `components loaded via -e match pattern ## Parts`,
      "fail",
      `missing: [${missing.join(", ")}]; loaded: [${[...loadedComponents].join(", ")}]`,
    );
  }

  if (extra.length > 0) {
    rubric.p1(
      "no unexpected components loaded",
      "fail",
      `extra: [${extra.join(", ")}]`,
    );
  } else {
    rubric.p1("no unexpected components loaded", "pass");
  }

  // Tool allowlist check — accept the union of (pattern.tools + extra_tools).
  const allowedTools = new Set(pattern.tools);
  if (spec.expectation.kind === "assembly") {
    for (const t of spec.expectation.extra_tools ?? []) allowedTools.add(t);
  }
  // For scout-then-draft the pattern exposes two allowlists in ## Parts —
  // we parse the union. Grading is lenient: each spawn's tools must be a
  // subset of (allowedTools ∪ {read} — read is generally safe to add).
  const safeReadExtras = new Set(["read"]);
  let allSpawnsOk = true;
  const violations: string[] = [];
  for (const s of spawns) {
    if (!s.toolsCsv) {
      allSpawnsOk = false;
      violations.push("spawn missing --tools flag");
      continue;
    }
    for (const t of s.tools) {
      if (!allowedTools.has(t) && !safeReadExtras.has(t)) {
        allSpawnsOk = false;
        violations.push(`unexpected tool: ${t}`);
      }
    }
  }
  rubric.p0(
    `--tools allowlist matches pattern (allowed: ${[...allowedTools].join(",")})`,
    allSpawnsOk ? "pass" : "fail",
    allSpawnsOk ? undefined : violations.join("; "),
  );

  // Forbidden tools — mandatory across every pattern.
  const forbidden = new Set(["write", "edit", "bash"]);
  const forbiddenHits: string[] = [];
  for (const s of spawns) {
    for (const t of s.tools) if (forbidden.has(t)) forbiddenHits.push(t);
  }
  rubric.p0(
    "no write/edit/bash in child tool allowlist",
    forbiddenHits.length === 0 ? "pass" : "fail",
    forbiddenHits.length === 0 ? undefined : `forbidden: [${forbiddenHits.join(", ")}]`,
  );

  // Mode
  const modeMatch = spawns.some((s) => s.mode === pattern.mode);
  rubric.p0(`--mode ${pattern.mode} on spawn`, modeMatch ? "pass" : "fail");
}

/* -------------------- Per-pattern semantic checks -------------------- */

function applyPerPatternChecks(
  rubric: Rubric,
  pattern: PatternName,
  art: ArtifactSet,
  spawns: SpawnInvocation[],
): void {
  switch (pattern) {
    case "drafter-with-approval":
      checkDrafterWithApproval(rubric, art);
      gradePathValidation(rubric, art);
      break;
    case "confined-drafter":
      checkConfinedDrafter(rubric, art, spawns);
      break;
    case "recon":
      checkRecon(rubric, art);
      break;
    case "scout-then-draft":
      checkScoutThenDraft(rubric, art, spawns);
      gradePathValidation(rubric, art);
      break;
    case "orchestrator":
      checkOrchestrator(rubric, art, spawns);
      break;
  }
}

function checkDrafterWithApproval(rubric: Rubric, art: ArtifactSet): void {
  rubric.say("## Per-pattern — drafter-with-approval");
  const hasConfirm = /ctx\.ui\.confirm/.test(art.extBlob);
  rubric.p0("ctx.ui.confirm before disk write", hasConfirm ? "pass" : "fail");
  const hasWrite = /fs\.writeFileSync\(/.test(art.extBlob);
  const hasMkdir = /fs\.mkdirSync\([\s\S]{0,200}?recursive[\s\S]{0,60}?true/.test(art.extBlob);
  rubric.p0(
    "fs.writeFileSync + mkdirSync recursive on promote",
    hasWrite && hasMkdir ? "pass" : "fail",
  );
  const hasStageHarvest = /["'`]stage_write["'`]/.test(art.extBlob) && /tool_execution_start/.test(art.extBlob);
  rubric.p0("harvest stage_write from tool_execution_start", hasStageHarvest ? "pass" : "fail");
  const hasSha = /createHash\(["']sha256["']\)/.test(art.extBlob);
  rubric.p1("sha256 post-write verify", hasSha ? "pass" : "fail");
}

function checkConfinedDrafter(rubric: Rubric, art: ArtifactSet, spawns: SpawnInvocation[]): void {
  rubric.say("## Per-pattern — confined-drafter");
  const hasConfirm = /ctx\.ui\.confirm/.test(art.extBlob);
  rubric.p0(
    "no ctx.ui.confirm (confined-drafter has no gate)",
    hasConfirm ? "fail" : "pass",
    hasConfirm ? "found ctx.ui.confirm in a confined-drafter agent" : undefined,
  );
  const parentWrites = /fs\.writeFileSync\(/.test(art.extBlob);
  rubric.p0(
    "no parent fs.writeFileSync (child writes directly)",
    parentWrites ? "fail" : "pass",
    parentWrites ? "parent should not write; child writes via sandbox_write" : undefined,
  );
  const sandboxEnv = /PI_SANDBOX_ROOT/.test(art.extBlob);
  rubric.p0(
    "PI_SANDBOX_ROOT set in child env",
    sandboxEnv ? "pass" : "fail",
  );
  const toolsOk = spawns.some(
    (s) => s.tools.includes("sandbox_write") && s.tools.includes("sandbox_edit"),
  );
  rubric.p0(
    "child --tools includes sandbox_write and sandbox_edit",
    toolsOk ? "pass" : "fail",
  );
}

function checkRecon(rubric: Rubric, art: ArtifactSet): void {
  rubric.say("## Per-pattern — recon");
  const hasConfirm = /ctx\.ui\.confirm/.test(art.extBlob);
  rubric.p0(
    "no ctx.ui.confirm (recon has nothing to gate)",
    hasConfirm ? "fail" : "pass",
    hasConfirm ? "found ctx.ui.confirm in a read-only agent" : undefined,
  );
  const hasEmitHarvest =
    /["'`]emit_summary["'`]/.test(art.extBlob) && /tool_execution_start/.test(art.extBlob);
  rubric.p0("harvest emit_summary from tool_execution_start", hasEmitHarvest ? "pass" : "fail");
  const hasStageHarvest = /["'`]stage_write["'`]/.test(art.extBlob);
  rubric.p0(
    "no stage_write-shape harvest (path/content args)",
    hasStageHarvest ? "fail" : "pass",
    hasStageHarvest ? "found drafter-shape harvest in a recon agent" : undefined,
  );
  const parentWrites = /fs\.writeFileSync\(/.test(art.extBlob);
  const hasScratch = /scratch/.test(art.extBlob);
  if (!parentWrites) {
    rubric.p0("no fs.writeFileSync outside .pi/scratch/", "pass", "no fs.writeFileSync calls");
  } else if (hasScratch) {
    rubric.p0("no fs.writeFileSync outside .pi/scratch/", "pass");
  } else {
    rubric.p0(
      "no fs.writeFileSync outside .pi/scratch/",
      "fail",
      "writeFileSync present but no 'scratch' anchor anywhere",
    );
  }
  const bounded =
    /\.slice\(0,\s*[0-9]+\)/.test(art.extBlob) || /Buffer\.byteLength\(/.test(art.extBlob);
  rubric.p0(
    "summary bounded (.slice(0, N) or Buffer.byteLength)",
    bounded ? "pass" : "fail",
  );
}

function checkScoutThenDraft(rubric: Rubric, art: ArtifactSet, spawns: SpawnInvocation[]): void {
  rubric.say("## Per-pattern — scout-then-draft");
  rubric.p0(
    "exactly two spawn('pi', [...]) calls",
    spawns.length === 2 ? "pass" : "fail",
    spawns.length === 2 ? undefined : `found ${spawns.length}`,
  );
  const hasConfirm = /ctx\.ui\.confirm/.test(art.extBlob);
  rubric.p0("ctx.ui.confirm before promotion", hasConfirm ? "pass" : "fail");
  const reconSpawn = spawns.find((s) => s.eFlagComponents.includes("emit-summary.ts"));
  const drafterSpawn = spawns.find((s) => s.eFlagComponents.includes("stage-write.ts"));
  rubric.p0(
    "recon spawn loads emit-summary.ts",
    reconSpawn ? "pass" : "fail",
  );
  rubric.p0(
    "drafter spawn loads cwd-guard.ts and stage-write.ts",
    drafterSpawn && drafterSpawn.eFlagComponents.includes("cwd-guard.ts") ? "pass" : "fail",
  );
  // Handoff: the drafter prompt should include the recon brief. Cheap
  // check: the source has a "brief" or "survey" or "Context" token near
  // a template string used in a spawn prompt.
  const hasBrief = /brief|survey|Context\s*—|Context\s*-/.test(art.extBlob);
  rubric.p0("handoff brief assembled between phases", hasBrief ? "pass" : "fail");
}

function checkOrchestrator(rubric: Rubric, art: ArtifactSet, spawns: SpawnInvocation[]): void {
  rubric.say("## Per-pattern — orchestrator");
  const rpcSpawn = spawns.find((s) => s.mode === "rpc");
  rubric.p0(
    "delegator spawn in --mode rpc",
    rpcSpawn ? "pass" : "fail",
  );
  const hasRunDispatch = /run_deferred_writer/.test(art.extBlob);
  const hasReview = /["'`]review["'`]/.test(art.extBlob);
  rubric.p0(
    "delegator tools include run_deferred_writer and review",
    hasRunDispatch && hasReview ? "pass" : "fail",
  );
}
