import fs from "node:fs";
import path from "node:path";
import {
  discoverArtifacts,
  extractCommandName,
  findDelegateUsage,
  findSpawnInvocations,
  type ArtifactSet,
  type DelegateUsage,
  type SpawnInvocation,
} from "../lib/artifact.ts";
import {
  COMPONENTS,
  forbiddenToolHits,
  isKnownComponent,
  type ComponentName,
  type Mark,
} from "../lib/component-spec.ts";
import {
  gradeNdjsonParsing,
  gradeNegativeAnchors,
  gradePathValidation,
  gradeRegisterToolShape,
  gradeRegistration,
  gradeSubprocessRails,
} from "../lib/core-rails.ts";
import { runBehavioralProbe, runLoadProbe, type ProbeContext } from "../lib/probes.ts";
import { Rubric } from "../lib/rubric.ts";
import { readFinalAssistantText } from "../lib/events.ts";
import {
  inferComposition,
  type CompositionExpectation,
  type CompositionTopology,
  type TestSpec,
} from "../lib/test-spec.ts";

export interface ComposerGraderArgs {
  repoRoot: string;
  logDir: string;
  model: string;
  task: string;
  spec: TestSpec;
}

export interface ComposerGraderResult {
  rubric: Rubric;
  kind: "composition" | "gap";
  composition?: CompositionTopology;
  components?: ComponentName[];
}

export function gradeComposerTask(args: ComposerGraderArgs): ComposerGraderResult {
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
  if (spec.expectation.kind !== "composition") {
    throw new Error(
      `composer grader received non-composition expectation: ${spec.expectation.kind}`,
    );
  }
  const composition = gradeComposition(rubric, args, spec.expectation);
  return {
    rubric,
    kind: "composition",
    composition,
    components: spec.expectation.components as ComponentName[],
  };
}

/* -------------------- GAP case -------------------------------------- */

function gradeGap(rubric: Rubric, args: ComposerGraderArgs): void {
  rubric.say("## Expected: GAP flag");
  const art = discoverArtifacts(args.logDir);
  const artifactCount = art.extensions.length + art.childTools.length;
  rubric.p0(
    "no artifacts produced (GAP case)",
    artifactCount === 0 ? "pass" : "fail",
    artifactCount === 0 ? undefined : `found ${artifactCount} file(s)`,
  );

  const eventsPath = path.join(args.logDir, "events.ndjson");
  const finalText = readFinalAssistantText(eventsPath);
  if (finalText === null) {
    rubric.p0(
      "GAP marker present in final assistant message",
      "fail",
      "events.ndjson missing or contains no message_end",
    );
    return;
  }
  // Same regex as the assembler GAP check — both skills emit byte-identical
  // GAP headers so graders share this anchor pair.
  const hasGap =
    /\bGAP\b/.test(finalText) && /I don't have a component/.test(finalText);
  rubric.p0(
    "GAP marker present in final assistant message",
    hasGap ? "pass" : "fail",
    hasGap
      ? undefined
      : "no 'GAP … I don\\'t have a component' in final message_end text",
  );
}

/* -------------------- Composition case ------------------------------ */

function gradeComposition(
  rubric: Rubric,
  args: ComposerGraderArgs,
  expectation: CompositionExpectation,
): CompositionTopology {
  const declaredComponents = expectation.components as ComponentName[];
  const declaredSet = new Set<ComponentName>(declaredComponents);

  // Resolve composition: explicit on the spec, or inferred. Inferred
  // emits a P1 warning so it's surfaced for review.
  let composition: CompositionTopology;
  let inferred = false;
  if (expectation.composition) {
    composition = expectation.composition;
  } else {
    composition = inferComposition(declaredComponents);
    inferred = true;
  }

  rubric.say(`## Expected: composition \`${composition}\`${inferred ? " (inferred)" : ""}`);
  rubric.say(`- components: ${declaredComponents.join(", ")}`);
  rubric.say(
    `- tools: ${unionToolsContribution(declaredComponents, expectation.extra_tools).join(",")}`,
  );
  rubric.say("");

  const art = discoverArtifacts(args.logDir, (_p, src) => classifyComposerStray(src));
  emitArtifactHeader(rubric, art, args.logDir);

  if (art.extensions.length === 0 && art.childTools.length === 0) {
    rubric.p0("at least one .ts artifact produced", "fail", "no output");
    return composition;
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
  const spawns = art.extensions.flatMap((f) =>
    findSpawnInvocations(fs.readFileSync(f, "utf8")),
  );
  const delegateUsage = findDelegateUsageOnExtensions(art);

  // P1: reward thin agents that ride on the delegate() runtime. Not
  // required for pass — inline-spawn agents are still fully graded
  // against the per-component rails below. See parts-first-plan §2.5.
  if (delegateUsage.usesDelegate) {
    rubric.p1("uses delegate() runtime (thin agent)", "pass");
  }

  gradeRegistration(rubric, art, cmdName);
  gradeRegisterToolShape(rubric, art);
  gradeSubprocessRails(rubric, art, spawns, delegateUsage);
  gradeNdjsonParsing(rubric, art, delegateUsage);

  // Composition-fidelity: each declared component's spawn-args + tool
  // contributions must appear in at least one spawn — unless the
  // component is handled by delegate(), where the wiring is indirect.
  gradeCompositionFidelity(rubric, declaredComponents, expectation, spawns, delegateUsage);

  // Per-component wiring.
  gradePerComponentWiring(rubric, declaredComponents, art, spawns, declaredSet, delegateUsage);

  // Composition-topology check.
  gradeTopology(rubric, composition, art, spawns, inferred);

  // Path validation when stage-write is in play (parent promotes; needs
  // the validation rail). delegate()-based thin agents defer to the
  // stage-write finalize + promote helper — gradePathValidation checks
  // usesDelegate internally and short-circuits.
  if (declaredSet.has("stage-write")) {
    gradePathValidation(rubric, art, delegateUsage);
  }

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
    // Recon mode iff emit-summary is the only harvest channel (no writes).
    const reconMode =
      declaredSet.has("emit-summary") &&
      !declaredSet.has("stage-write") &&
      !declaredSet.has("cwd-guard");
    runBehavioralProbe(rubric, ctx, reconMode ? "recon" : "writer");
  }

  return composition;
}

function classifyComposerStray(src: string): "ext" | "child" | "ignore" {
  if (/registerCommand/.test(src)) return "ext";
  if (
    /registerTool/.test(src) &&
    /stage_write|emit_summary|sandbox_write|review\b|run_deferred_writer/.test(src)
  ) {
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

/* -------------------- Composition fidelity --------------------------- */

function gradeCompositionFidelity(
  rubric: Rubric,
  declaredComponents: ComponentName[],
  expectation: CompositionExpectation,
  spawns: SpawnInvocation[],
  delegateUsage: DelegateUsage,
): void {
  rubric.say(`## Composition fidelity`);
  const thinAgent = spawns.length === 0 && delegateUsage.usesDelegate;
  if (thinAgent) {
    rubric.p0(
      "delegate({components: [...]}) call in extension",
      "pass",
      "spawn + wiring live in ../lib/delegate.ts",
    );
  } else if (spawns.length === 0) {
    rubric.p0("at least one spawn('pi', [...]) call", "fail", "no spawn found");
    return;
  } else {
    rubric.p0("at least one spawn('pi', [...]) call", "pass");
  }

  const expectedFilenames = new Set(
    declaredComponents.map((c) => COMPONENTS[c].filename),
  );
  // For thin agents, the "loaded" set comes from delegate()'s components
  // array (resolved to filenames via parentSide imports). For inline-spawn
  // agents, it comes from each spawn's -e args.
  const loadedFilenames = new Set<string>();
  if (thinAgent) {
    for (const name of delegateUsage.delegateHandles) {
      const spec = COMPONENTS[name as ComponentName];
      if (spec) loadedFilenames.add(spec.filename);
    }
  } else {
    for (const s of spawns) for (const c of s.eFlagComponents) loadedFilenames.add(c);
    // Orchestrators drive the drafter spawn through delegate() and the
    // RPC delegator spawn inline — union both so a split wiring passes.
    for (const name of delegateUsage.delegateHandles) {
      const spec = COMPONENTS[name as ComponentName];
      if (spec) loadedFilenames.add(spec.filename);
    }
  }

  const missing = [...expectedFilenames].filter((f) => !loadedFilenames.has(f));
  if (missing.length === 0) {
    rubric.p0(
      "components loaded via -e match declared component set",
      "pass",
      `[${[...expectedFilenames].join(", ")}]`,
    );
  } else {
    rubric.p0(
      "components loaded via -e match declared component set",
      "fail",
      `missing: [${missing.join(", ")}]; loaded: [${[...loadedFilenames].join(", ")}]`,
    );
  }

  // P1: no unexpected components beyond the declared set. Allow any
  // .ts file that's not in the canonical component library to slip
  // through (test fixtures, ad-hoc helpers loaded for other reasons).
  const knownComponentFiles = new Set(
    Object.values(COMPONENTS).map((c) => c.filename),
  );
  const unexpected = [...loadedFilenames].filter(
    (f) => knownComponentFiles.has(f) && !expectedFilenames.has(f),
  );
  if (unexpected.length > 0) {
    rubric.p1(
      "no unexpected components loaded beyond declared set",
      "fail",
      `extra: [${unexpected.join(", ")}]`,
    );
  } else {
    rubric.p1("no unexpected components loaded beyond declared set", "pass");
  }

  // Tool allowlist: union of each component's contribution + extra_tools.
  // Each spawn's tools must be a subset of (allowed ∪ {ls, read, grep,
  // glob} — the read-only verbs are always safe). Thin agents delegate
  // the --tools assembly to delegate() itself, which unions each
  // component's parentSide.tools and rejects the forbidden trio — so
  // the check collapses to "is the component set correct?", which the
  // declared-vs-loaded filename check above already asserts.
  if (thinAgent) {
    rubric.p0(
      "--tools allowlist unioned by delegate() from parentSide contributions",
      "pass",
    );
    rubric.p0(
      "no write/edit/bash in child tool allowlist (enforced by delegate())",
      "pass",
    );
    return;
  }
  const allowedTools = new Set<string>(
    unionToolsContribution(declaredComponents, expectation.extra_tools),
  );
  const safeReadExtras = new Set(["ls", "read", "grep", "glob"]);
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
    `--tools allowlist matches component union (allowed: ${[...allowedTools].join(",")})`,
    allSpawnsOk ? "pass" : "fail",
    allSpawnsOk ? undefined : violations.join("; "),
  );

  // Forbidden tools: write/edit/bash never appear, regardless of
  // composition.
  const forbiddenHits = forbiddenToolHits(spawns);
  rubric.p0(
    "no write/edit/bash in child tool allowlist",
    forbiddenHits.length === 0 ? "pass" : "fail",
    forbiddenHits.length === 0
      ? undefined
      : `forbidden: [${forbiddenHits.join(", ")}]`,
  );
}

function unionToolsContribution(
  components: ReadonlyArray<string>,
  extras: ReadonlyArray<string> | undefined,
): string[] {
  const tools = new Set<string>();
  for (const c of components) {
    if (!isKnownComponent(c)) continue;
    for (const t of COMPONENTS[c].toolsContribution) tools.add(t);
  }
  for (const t of extras ?? []) tools.add(t);
  return [...tools];
}

/* -------------------- Per-component wiring --------------------------- */

function gradePerComponentWiring(
  rubric: Rubric,
  declaredComponents: ComponentName[],
  art: ArtifactSet,
  spawns: SpawnInvocation[],
  components: Set<ComponentName>,
  delegateUsage: DelegateUsage,
): void {
  rubric.say(`## Per-component wiring`);
  const delegateHandles = new Set<ComponentName>();
  for (const n of delegateUsage.delegateHandles) {
    if (isKnownComponent(n)) delegateHandles.add(n);
  }
  const importedComponents = new Set<ComponentName>();
  for (const n of delegateUsage.importedComponents) {
    if (isKnownComponent(n)) importedComponents.add(n);
  }
  for (const name of declaredComponents) {
    if (!isKnownComponent(name)) continue;
    const marks = COMPONENTS[name].wiringChecks({
      art,
      spawns,
      components,
      delegateHandles,
      importedComponents,
    });
    for (const m of marks) emitMark(rubric, m);
  }
}

/** Collapse every generated extension's delegate usage into one
 *  {@link DelegateUsage} value. Multi-file extensions are rare in
 *  composer output but we handle them by unioning imports + handle
 *  sets so any file's delegate() call counts. */
function findDelegateUsageOnExtensions(art: ArtifactSet): DelegateUsage {
  let usesDelegate = false;
  const importedComponents = new Set<string>();
  const delegateHandles = new Set<string>();
  for (const f of art.extensions) {
    const src = fs.readFileSync(f, "utf8");
    const u = findDelegateUsage(src);
    if (u.usesDelegate) usesDelegate = true;
    for (const c of u.importedComponents) importedComponents.add(c);
    for (const c of u.delegateHandles) delegateHandles.add(c);
  }
  return { usesDelegate, importedComponents, delegateHandles };
}

function emitMark(rubric: Rubric, m: Mark): void {
  if (m.severity === "P0") rubric.p0(m.name, m.status, m.note);
  else rubric.p1(m.name, m.status, m.note);
}

/* -------------------- Composition-topology check --------------------- */

function gradeTopology(
  rubric: Rubric,
  composition: CompositionTopology,
  art: ArtifactSet,
  spawns: SpawnInvocation[],
  inferred: boolean,
): void {
  rubric.say(`## Composition topology`);
  if (inferred) {
    rubric.p1(
      "topology is explicit on the test spec",
      "fail",
      "no `composition:` field — inferred from component set",
    );
  }

  switch (composition) {
    case "single-spawn": {
      const ok = spawns.length === 1;
      rubric.p0(
        "single-spawn: exactly one spawn('pi', [...])",
        ok ? "pass" : "fail",
        ok ? undefined : `found ${spawns.length}`,
      );
      break;
    }
    case "sequential-phases-with-brief": {
      const enoughSpawns = spawns.length >= 2;
      rubric.p0(
        "sequential-phases-with-brief: at least two spawn('pi', [...]) calls",
        enoughSpawns ? "pass" : "fail",
        enoughSpawns ? undefined : `found ${spawns.length}`,
      );
      const briefAssembled =
        /Buffer\.byteLength\(/.test(art.extBlob) &&
        /(brief|summary|survey|Context\s*[—-])/i.test(art.extBlob);
      rubric.p0(
        "sequential-phases-with-brief: brief assembled with bounded byte length",
        briefAssembled ? "pass" : "fail",
      );
      break;
    }
    case "rpc-delegator-over-concurrent-drafters": {
      const rpcSpawn = spawns.some((s) => s.mode === "rpc");
      rubric.p0(
        "rpc-delegator: a spawn uses --mode rpc",
        rpcSpawn ? "pass" : "fail",
      );
      // Concurrent dispatch only required when run-deferred-writer is in
      // the set; a [stage-write, review] composition is RPC-shaped but
      // single-drafter, so Promise.all isn't mandatory there.
      const dispatchToolListed = spawns.some((s) =>
        s.tools.includes("run_deferred_writer"),
      );
      if (dispatchToolListed) {
        const hasParallel = /Promise\.all\(/.test(art.extBlob);
        rubric.p0(
          "rpc-delegator: Promise.all dispatch when run-deferred-writer ∈ components",
          hasParallel ? "pass" : "fail",
        );
      }
      break;
    }
  }
}
