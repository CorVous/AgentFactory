import type { ArtifactSet, SpawnInvocation } from "./artifact.ts";

/**
 * Per-component wiring-check registry. The composer grader iterates
 * `expectation.components`, looks up each ComponentSpec here, and
 * applies its wiring checks against the harvested artifacts and
 * spawn invocations.
 *
 * The regex anchors here are the same ones used in the assembler
 * grader's per-pattern checks (`scripts/grader/graders/assembler.ts`),
 * re-homed per-component instead of per-pattern. A pattern that uses
 * stage-write triggers exactly the stage-write wiring checks; a
 * pattern that uses stage-write + review triggers stage-write's
 * checks adjusted for the LLM-gate variant.
 */

export const COMPONENT_NAMES = [
  "cwd-guard",
  "stage-write",
  "emit-summary",
  "review",
  "run-deferred-writer",
] as const;

export type ComponentName = (typeof COMPONENT_NAMES)[number];

export function isKnownComponent(name: string): name is ComponentName {
  return (COMPONENT_NAMES as readonly string[]).includes(name);
}

export interface Mark {
  severity: "P0" | "P1";
  name: string;
  status: "pass" | "fail";
  note?: string;
}

export interface WiringContext {
  art: ArtifactSet;
  spawns: SpawnInvocation[];
  /** Full component set declared on the test spec. */
  components: Set<ComponentName>;
  /** Set of components whose inline rail evidence can be trusted to
   *  `pi-sandbox/.pi/lib/delegate.ts` (Phase 2.5). Populated from
   *  {@link artifact.findDelegateUsage}. A component in this set has
   *  its per-rail regex anchors short-circuited to "pass — handled by
   *  delegate()", since the extension body delegates that rail to the
   *  shared runtime and the rail-level checks live in delegate.ts
   *  itself. */
  delegateHandles: Set<ComponentName>;
  /** Set of components the extension imports from `../components/*.ts`.
   *  Broader than `delegateHandles` — an orchestrator imports `REVIEW`
   *  and `RUN_DEFERRED_WRITER` for their harvesters but drives its own
   *  RPC spawn, so those aren't in `delegateHandles`. Checks that only
   *  need to know "the component's harvester is being used" (instead of
   *  the full delegate() wiring) can key off this set. */
  importedComponents: Set<ComponentName>;
}

export interface ComponentSpec {
  name: ComponentName;
  /** The basename loaded via `pi -e <abs path>/<filename>`. */
  filename: string;
  /** Tokens this component contributes to the child's --tools allowlist. */
  toolsContribution: string[];
  /** Per-component wiring assertions; receives the full component set so
   *  cross-component predicates (e.g. confirm-gate when stage-write ∈ but
   *  review ∉) can vary their behavior. */
  wiringChecks(ctx: WiringContext): Mark[];
}

// Mirrors the runtime forbidden set in pi-sandbox/.pi/lib/delegate.ts.
// cwd-guard's `sandbox_*` family is the only fs channel allowed; the
// built-ins read/ls/grep/glob/write/edit and `bash` are never permitted
// in a child's --tools allowlist.
const FORBIDDEN_TOOLS = new Set([
  "write", "edit", "bash",
  "read", "ls", "grep", "glob",
]);

// The full menu of sandbox verbs cwd-guard can register. Any spawn whose
// --tools CSV includes one of these must load cwd-guard.ts (-e flag) and
// pass PI_SANDBOX_ROOT + PI_SANDBOX_VERBS in the child env.
const SANDBOX_VERBS: ReadonlySet<string> = new Set([
  "sandbox_read", "sandbox_ls", "sandbox_grep", "sandbox_glob",
  "sandbox_write", "sandbox_edit",
]);

export const COMPONENTS: Record<ComponentName, ComponentSpec> = {
  "cwd-guard": {
    name: "cwd-guard",
    filename: "cwd-guard.ts",
    toolsContribution: [
      "sandbox_read", "sandbox_ls", "sandbox_grep", "sandbox_glob",
      "sandbox_write", "sandbox_edit",
    ],
    wiringChecks({ art, spawns, delegateHandles }) {
      const out: Mark[] = [];
      if (delegateHandles.has("cwd-guard")) {
        // delegate() internally concatenates cwd-guard.parentSide.spawnArgs
        // (i.e. `-e <cwd-guard.ts>`) and merges PI_SANDBOX_ROOT +
        // PI_SANDBOX_VERBS into env. The extension body won't contain
        // those string literals, so the inline anchors below would
        // false-negative; short-circuit instead.
        out.push({
          severity: "P0",
          name: "cwd-guard: handled by delegate() runtime",
          status: "pass",
        });
        return out;
      }
      const sandboxRootEnv = /PI_SANDBOX_ROOT/.test(art.extBlob);
      out.push({
        severity: "P0",
        name: "cwd-guard: PI_SANDBOX_ROOT in child env",
        status: sandboxRootEnv ? "pass" : "fail",
      });
      const sandboxVerbsEnv = /PI_SANDBOX_VERBS/.test(art.extBlob);
      out.push({
        severity: "P0",
        name: "cwd-guard: PI_SANDBOX_VERBS in child env",
        status: sandboxVerbsEnv ? "pass" : "fail",
      });
      // Defense-in-depth rule: cwd-guard is required on EVERY sub-pi
      // spawn, even no-fs roles (e.g. RPC delegators with only
      // run_deferred_writer,review). Empty PI_SANDBOX_VERBS makes
      // cwd-guard register zero tools but keeps the guard on the argv
      // — see pi-sandbox/.pi/components/cwd-guard.ts header.
      const missing = spawns
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => !s.eFlagComponents.includes("cwd-guard.ts"));
      out.push({
        severity: "P0",
        name: "cwd-guard: -e cwd-guard.ts on every spawn",
        status: missing.length === 0 ? "pass" : "fail",
        note:
          missing.length === 0
            ? undefined
            : `${missing.length} spawn(s) missing -e cwd-guard.ts (defense-in-depth requires it on every sub-pi)`,
      });
      return out;
    },
  },
  "stage-write": {
    name: "stage-write",
    filename: "stage-write.ts",
    toolsContribution: ["stage_write"],
    wiringChecks({ art, components, delegateHandles }) {
      const out: Mark[] = [];
      const blob = art.extBlob;
      if (delegateHandles.has("stage-write")) {
        // stage-write.parentSide.finalize does the validation + sha256,
        // delegate() does the promote + rails.md §10 confirm/verdict
        // gating. None of those string literals live in the extension
        // when it's a delegate-based thin agent.
        out.push({
          severity: "P0",
          name: "stage-write: handled by delegate() runtime",
          status: "pass",
        });
        return out;
      }
      const hasStageHarvest =
        /["'`]stage_write["'`]/.test(blob) && /tool_execution_start/.test(blob);
      out.push({
        severity: "P0",
        name: "stage-write: harvest stage_write from tool_execution_start",
        status: hasStageHarvest ? "pass" : "fail",
      });
      const hasWrite = /fs\.writeFileSync\(/.test(blob);
      const hasMkdir = /fs\.mkdirSync\([\s\S]{0,200}?recursive[\s\S]{0,60}?true/.test(
        blob,
      );
      out.push({
        severity: "P0",
        name: "stage-write: fs.writeFileSync + mkdirSync recursive on promote",
        status: hasWrite && hasMkdir ? "pass" : "fail",
      });
      const hasSha = /createHash\(["']sha256["']\)/i.test(blob);
      out.push({
        severity: "P1",
        name: "stage-write: sha256 post-write verify",
        status: hasSha ? "pass" : "fail",
      });
      // Confirm-gate predicate: required iff stage-write ∈ && review ∉.
      const hasConfirm = /ctx\.ui\.confirm/.test(blob);
      const reviewInSet = components.has("review");
      if (reviewInSet) {
        out.push({
          severity: "P0",
          name: "stage-write: no ctx.ui.confirm when review ∈ components (LLM is the gate)",
          status: hasConfirm ? "fail" : "pass",
          note: hasConfirm
            ? "found ctx.ui.confirm alongside review — double-gating breaks orchestrator autonomy"
            : undefined,
        });
      } else {
        out.push({
          severity: "P0",
          name: "stage-write: ctx.ui.confirm before disk write (review ∉ components)",
          status: hasConfirm ? "pass" : "fail",
        });
      }
      return out;
    },
  },
  "emit-summary": {
    name: "emit-summary",
    filename: "emit-summary.ts",
    toolsContribution: ["emit_summary"],
    wiringChecks({ art, components, delegateHandles }) {
      const out: Mark[] = [];
      const blob = art.extBlob;
      if (delegateHandles.has("emit-summary")) {
        // emit-summary.parentSide.finalize enforces the per-body byte
        // cap and hands back a Summary list; the thin-agent wrapper
        // decides what to do with it. Skip the inline "byte cap" anchor
        // since the cap lives in the component's finalize now.
        out.push({
          severity: "P0",
          name: "emit-summary: handled by delegate() runtime",
          status: "pass",
        });
        return out;
      }
      const hasEmitHarvest =
        /["'`]emit_summary["'`]/.test(blob) && /tool_execution_start/.test(blob);
      out.push({
        severity: "P0",
        name: "emit-summary: harvest emit_summary from tool_execution_start",
        status: hasEmitHarvest ? "pass" : "fail",
      });
      const bounded =
        /Buffer\.byteLength\(/.test(blob) || /\.slice\(0,\s*[0-9]+\)/.test(blob);
      out.push({
        severity: "P0",
        name: "emit-summary: per-body byte cap (Buffer.byteLength or .slice(0, N))",
        status: bounded ? "pass" : "fail",
      });
      // When emit-summary is the ONLY harvest channel (no stage-write),
      // the parent must not call ctx.ui.confirm — there's nothing to gate.
      if (!components.has("stage-write")) {
        const hasConfirm = /ctx\.ui\.confirm/.test(blob);
        out.push({
          severity: "P0",
          name: "emit-summary: no ctx.ui.confirm in summary-only flow",
          status: hasConfirm ? "fail" : "pass",
          note: hasConfirm
            ? "found ctx.ui.confirm in a read-only summary flow"
            : undefined,
        });
      }
      return out;
    },
  },
  review: {
    name: "review",
    filename: "review.ts",
    toolsContribution: ["review"],
    wiringChecks({ art, spawns, importedComponents }) {
      const out: Mark[] = [];
      const blob = art.extBlob;
      const rpcSpawn = spawns.find((s) => s.mode === "rpc");
      out.push({
        severity: "P0",
        name: "review: a spawn uses --mode rpc (delegator)",
        status: rpcSpawn ? "pass" : "fail",
      });
      const reviewToolListed = spawns.some((s) => s.tools.includes("review"));
      out.push({
        severity: "P0",
        name: "review: --tools includes review on the delegator spawn",
        status: reviewToolListed ? "pass" : "fail",
      });
      // Accept either inline literal harvest (pre-Phase-2.3) or
      // imported-parentSide harvest (`REVIEW.harvest(ev, …)` or
      // `REVIEW.parentSide.harvest(…)`) — the refactored orchestrator
      // drives review parsing through the component's harvester and
      // the literal "review" string never lands in its body.
      const inlineHarvest =
        /["'`]review["'`]/.test(blob) && /tool_execution_start/.test(blob);
      const importedHarvest =
        importedComponents.has("review") &&
        /\b[A-Z_][A-Z0-9_]*\s*\.\s*(?:parentSide\s*\.\s*)?harvest\s*\(/.test(blob);
      out.push({
        severity: "P0",
        name: "review: harvest review verdict from tool_execution_start",
        status: inlineHarvest || importedHarvest ? "pass" : "fail",
      });
      return out;
    },
  },
  "run-deferred-writer": {
    name: "run-deferred-writer",
    filename: "run-deferred-writer.ts",
    toolsContribution: ["run_deferred_writer"],
    wiringChecks({ art, spawns, importedComponents }) {
      const out: Mark[] = [];
      const blob = art.extBlob;
      const dispatchToolListed = spawns.some((s) =>
        s.tools.includes("run_deferred_writer"),
      );
      out.push({
        severity: "P0",
        name: "run-deferred-writer: --tools includes run_deferred_writer on delegator",
        status: dispatchToolListed ? "pass" : "fail",
      });
      // Either the literal "run_deferred_writer" appears in a
      // tool_execution_start switch (pre-Phase-2.3) or the component's
      // parentSide.harvest is imported and called (`RUN_DEFERRED_WRITER
      // .harvest(ev, …)`). Post-refactor the literal moves into the
      // component file, so the extension body only shows the import +
      // call.
      const inlineHarvest =
        /run_deferred_writer/.test(blob) && /tool_execution_start/.test(blob);
      const importedHarvest =
        importedComponents.has("run-deferred-writer") &&
        /\b[A-Z_][A-Z0-9_]*\s*\.\s*(?:parentSide\s*\.\s*)?harvest\s*\(/.test(blob);
      out.push({
        severity: "P0",
        name: "run-deferred-writer: harvest run_deferred_writer from tool_execution_start",
        status: inlineHarvest || importedHarvest ? "pass" : "fail",
      });
      const hasParallel = /Promise\.all\(/.test(blob);
      out.push({
        severity: "P0",
        name: "run-deferred-writer: Promise.all for concurrent drafter dispatch",
        status: hasParallel ? "pass" : "fail",
      });
      return out;
    },
  },
};

export function forbiddenToolHits(spawns: SpawnInvocation[]): string[] {
  const hits: string[] = [];
  for (const s of spawns) {
    for (const t of s.tools) if (FORBIDDEN_TOOLS.has(t)) hits.push(t);
  }
  return hits;
}
