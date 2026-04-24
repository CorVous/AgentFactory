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

const FORBIDDEN_TOOLS = new Set(["write", "edit", "bash"]);

export const COMPONENTS: Record<ComponentName, ComponentSpec> = {
  "cwd-guard": {
    name: "cwd-guard",
    filename: "cwd-guard.ts",
    toolsContribution: ["sandbox_write", "sandbox_edit"],
    wiringChecks({ art, spawns }) {
      const out: Mark[] = [];
      const sandboxEnv = /PI_SANDBOX_ROOT/.test(art.extBlob);
      out.push({
        severity: "P0",
        name: "cwd-guard: PI_SANDBOX_ROOT in child env",
        status: sandboxEnv ? "pass" : "fail",
      });
      const writeCapableSpawn = spawns.some(
        (s) =>
          s.tools.includes("sandbox_write") || s.tools.includes("sandbox_edit"),
      );
      const cwdGuardLoaded = spawns.some((s) =>
        s.eFlagComponents.includes("cwd-guard.ts"),
      );
      out.push({
        severity: "P0",
        name: "cwd-guard: -e cwd-guard.ts on every write-capable spawn",
        status: writeCapableSpawn && !cwdGuardLoaded ? "fail" : "pass",
        note:
          writeCapableSpawn && !cwdGuardLoaded
            ? "spawn lists sandbox_write/sandbox_edit but did not load cwd-guard.ts"
            : undefined,
      });
      return out;
    },
  },
  "stage-write": {
    name: "stage-write",
    filename: "stage-write.ts",
    toolsContribution: ["stage_write"],
    wiringChecks({ art, components }) {
      const out: Mark[] = [];
      const blob = art.extBlob;
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
    wiringChecks({ art, components }) {
      const out: Mark[] = [];
      const blob = art.extBlob;
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
    wiringChecks({ art, spawns }) {
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
      const hasVerdictHarvest =
        /["'`]review["'`]/.test(blob) && /tool_execution_start/.test(blob);
      out.push({
        severity: "P0",
        name: "review: harvest review verdict from tool_execution_start",
        status: hasVerdictHarvest ? "pass" : "fail",
      });
      return out;
    },
  },
  "run-deferred-writer": {
    name: "run-deferred-writer",
    filename: "run-deferred-writer.ts",
    toolsContribution: ["run_deferred_writer"],
    wiringChecks({ art, spawns }) {
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
      const hasDispatchHarvest =
        /run_deferred_writer/.test(blob) && /tool_execution_start/.test(blob);
      out.push({
        severity: "P0",
        name: "run-deferred-writer: harvest run_deferred_writer from tool_execution_start",
        status: hasDispatchHarvest ? "pass" : "fail",
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
