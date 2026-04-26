// dispatch-spec.ts — shared engine for running an emitted YAML agent
// spec through `delegate()`. Both the YAML runner extension (the
// user-facing slash-command path) and the dispatch-agent component
// (the agent-calls-agent path) consume runSpec here, so the per-
// composition wiring lives in one place.
//
// Three runnable topologies:
//   - single-spawn
//   - sequential-phases-with-brief
//   - single-spawn-with-dispatch  (the dispatcher topology — phase
//     declares dispatch-agent in components, dispatch_agent in tools)
//
// The orchestrator topology (review + run-deferred-writer) is NOT
// runnable here. emit_agent_spec rejects those components at write
// time; validateSpec rejects them at registration / dispatch time.

import * as fs from "node:fs";
import * as path from "node:path";

import { parentSide as DISPATCH_AGENT } from "../components/dispatch-agent.ts";
import { parentSide as EMIT_AGENT_SPEC } from "../components/emit-agent-spec.ts";
import { parentSide as EMIT_SUMMARY } from "../components/emit-summary.ts";
import { parentSide as STAGE_WRITE } from "../components/stage-write.ts";
import type {
  EmitSummaryResult,
  ParentSide,
  UiCtx,
} from "../components/_parent-side.ts";
import { delegate, type DelegateResult } from "./delegate.ts";
import { reservedComponentNames } from "./auto-inject.ts";

/** Maximum bytes a phase-1 → phase-2 brief may occupy in the
 *  template-substituted phase-2 prompt. Keep in lockstep with the
 *  comment in compositions.md. */
export const MAX_BRIEF_BYTES = 16_000;

export type Composition =
  | "single-spawn"
  | "sequential-phases-with-brief"
  | "single-spawn-with-dispatch";

export interface PhaseSpec {
  name?: string;
  components: string[];
  /** Optional explicit child --tools allowlist. When omitted,
   *  delegate unions the components' declared tools. */
  tools?: string[];
  prompt: string;
}

export interface AgentSpec {
  name: string;
  slash: string;
  description: string;
  composition: Composition;
  /** Optional skill path; passed as `--skill <path>` (with --no-skills)
   *  on every phase. Resolved relative to pi's cwd at validation time
   *  (must be an existing directory). */
  skill?: string;
  phases: PhaseSpec[];
}

/**
 * User-listable component registry. cwd-guard and sandbox-fs are
 * NOT here — they're auto-injected by delegate() via the POLICIES
 * and TOOL_PROVIDERS registries, and listing either name in a
 * phase's `components` is rejected by validateSpec.
 *
 * Each entry is a thunk so the live binding from the imported
 * parentSide is captured even if module load order is partial
 * (dispatch-agent imports back into this file via runSpec). With
 * thunks, the binding is dereferenced only when COMPONENTS[name]()
 * is invoked at runtime, by which time all module init has
 * completed.
 */
export const COMPONENTS: Record<string, () => ParentSide<any, unknown>> = {
  "stage-write": () => STAGE_WRITE,
  "emit-summary": () => EMIT_SUMMARY,
  "emit-agent-spec": () => EMIT_AGENT_SPEC,
  "dispatch-agent": () => DISPATCH_AGENT,
};

export interface RunSpecResult {
  /** Aggregate count of files promoted across every phase. */
  promotedCount: number;
  /** Sum of `costUsd` across every phase. */
  totalCost: number;
  /** Per-phase delegate result, keyed by phase index (0, 1, …). */
  phases: DelegateResult[];
  /** Aggregate stderr-derived errors and per-phase skips, deduped. */
  errors: string[];
}

/**
 * Run a validated AgentSpec end-to-end. Threads `ctx` through every
 * phase's `delegate()` call so any nested gate (stage_write
 * confirms, emit_agent_spec confirms, dispatch-agent's own gates)
 * renders in whichever process owns the user's TUI.
 */
export async function runSpec(
  ctx: UiCtx,
  spec: AgentSpec,
  args: string,
): Promise<RunSpecResult> {
  const sandboxRoot = path.resolve(process.cwd());
  const baseSubs = { args, sandboxRoot };
  const totals: RunSpecResult = {
    promotedCount: 0,
    totalCost: 0,
    phases: [],
    errors: [],
  };

  if (
    spec.composition === "single-spawn" ||
    spec.composition === "single-spawn-with-dispatch"
  ) {
    const phase = spec.phases[0];
    const r = await delegate(ctx, {
      components: phase.components.map((n) => COMPONENTS[n]()),
      prompt: substitute(phase.prompt, baseSubs),
      skill: spec.skill,
      toolsOverride: phase.tools,
    });
    accumulate(totals, r);
    return totals;
  }

  if (spec.composition === "sequential-phases-with-brief") {
    const scoutPhase = spec.phases[0];
    const draftPhase = spec.phases[1];
    const scoutResult = await delegate(ctx, {
      components: scoutPhase.components.map((n) => COMPONENTS[n]()),
      prompt: substitute(scoutPhase.prompt, baseSubs),
      skill: spec.skill,
      toolsOverride: scoutPhase.tools,
    });
    accumulate(totals, scoutResult);
    const summaries =
      (scoutResult.byComponent.get("emit-summary") as
        | EmitSummaryResult
        | undefined)?.summaries ?? [];
    if (summaries.length === 0) {
      totals.errors.push("scout phase emitted no summaries; aborting before drafter");
      return totals;
    }
    const brief = buildBrief(summaries);
    if (Buffer.byteLength(brief, "utf8") > MAX_BRIEF_BYTES) {
      totals.errors.push(
        `brief is ${Buffer.byteLength(brief, "utf8")} bytes > ${MAX_BRIEF_BYTES} budget; aborting`,
      );
      return totals;
    }
    const draftResult = await delegate(ctx, {
      components: draftPhase.components.map((n) => COMPONENTS[n]()),
      prompt: substitute(draftPhase.prompt, { ...baseSubs, brief }),
      skill: spec.skill,
      toolsOverride: draftPhase.tools,
    });
    accumulate(totals, draftResult);
    return totals;
  }

  totals.errors.push(`unknown composition: ${(spec as AgentSpec).composition}`);
  return totals;
}

function accumulate(totals: RunSpecResult, r: DelegateResult): void {
  totals.promotedCount += r.promoted.length;
  totals.totalCost += r.costUsd;
  totals.phases.push(r);
  for (const s of r.skips) totals.errors.push(s);
}

export function substitute(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(args|sandboxRoot|brief)\}/g, (m, key) => {
    const v = vars[key];
    return v === undefined ? m : v;
  });
}

/**
 * Concatenate scout-phase summaries into a `## title\nbody` block.
 * Caller is responsible for the byte-budget check.
 */
export function buildBrief(
  summaries: ReadonlyArray<{ title: string; body: string }>,
): string {
  return summaries.map((s) => `## ${s.title}\n${s.body}`).join("\n\n");
}

const KNOWN_COMPOSITIONS: ReadonlySet<Composition> = new Set([
  "single-spawn",
  "sequential-phases-with-brief",
  "single-spawn-with-dispatch",
]);

/**
 * Strict validator for raw YAML / object input. Rejects unknown
 * compositions, unknown components, RPC-only components (review,
 * run-deferred-writer), reserved component names (cwd-guard,
 * sandbox-fs — auto-injected), missing fields, and malformed
 * tools arrays. Returns a typed AgentSpec on success.
 *
 * The composition-specific phase-shape rules:
 *   - single-spawn → exactly 1 phase.
 *   - sequential-phases-with-brief → exactly 2 phases; phase 1 must
 *     include emit-summary, phase 2 must include stage-write.
 *   - single-spawn-with-dispatch → exactly 1 phase that includes
 *     dispatch-agent in components and dispatch_agent in tools.
 */
export function validateSpec(raw: unknown, file: string): AgentSpec {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${file}: not an object`);
  }
  const r = raw as Record<string, unknown>;
  const name = expectString(r, "name", file);
  const slash = expectString(r, "slash", file);
  const description = expectString(r, "description", file);
  const composition = expectString(r, "composition", file) as Composition;
  if (!KNOWN_COMPOSITIONS.has(composition)) {
    throw new Error(
      `${file}: composition "${composition}" not runnable here. ` +
        `Only ${[...KNOWN_COMPOSITIONS].join(", ")} are supported. ` +
        `Use pi-agent-builder for orchestrator topologies.`,
    );
  }
  const phasesRaw = r.phases;
  if (!Array.isArray(phasesRaw) || phasesRaw.length === 0) {
    throw new Error(`${file}: phases must be a non-empty array`);
  }
  const phases: PhaseSpec[] = phasesRaw.map((p, i) =>
    validatePhase(p, i, file),
  );

  if (composition === "single-spawn" && phases.length !== 1) {
    throw new Error(
      `${file}: single-spawn requires exactly 1 phase, got ${phases.length}`,
    );
  }
  if (composition === "single-spawn-with-dispatch") {
    if (phases.length !== 1) {
      throw new Error(
        `${file}: single-spawn-with-dispatch requires exactly 1 phase, got ${phases.length}`,
      );
    }
    if (!phases[0].components.includes("dispatch-agent")) {
      throw new Error(
        `${file}: single-spawn-with-dispatch: phase must include ` +
          `"dispatch-agent" in components.`,
      );
    }
    if (!phases[0].tools || !phases[0].tools.includes("dispatch_agent")) {
      throw new Error(
        `${file}: single-spawn-with-dispatch: phase must include ` +
          `"dispatch_agent" in tools.`,
      );
    }
  }
  if (
    composition === "sequential-phases-with-brief" &&
    phases.length !== 2
  ) {
    throw new Error(
      `${file}: sequential-phases-with-brief requires exactly 2 phases, ` +
        `got ${phases.length}`,
    );
  }
  if (composition === "sequential-phases-with-brief") {
    if (!phases[0].components.includes("emit-summary")) {
      throw new Error(
        `${file}: sequential-phases-with-brief: phase 1 must include ` +
          `"emit-summary".`,
      );
    }
    if (!phases[1].components.includes("stage-write")) {
      throw new Error(
        `${file}: sequential-phases-with-brief: phase 2 must include ` +
          `"stage-write".`,
      );
    }
  }

  let skill: string | undefined;
  if (r.skill !== undefined) {
    if (typeof r.skill !== "string" || r.skill.length === 0) {
      throw new Error(`${file}: skill must be a non-empty string when set`);
    }
    const resolved = path.resolve(process.cwd(), r.skill);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`${file}: skill path does not exist: ${resolved}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${file}: skill path is not a directory: ${resolved}`);
    }
    skill = resolved;
  }

  return { name, slash, description, composition, skill, phases };
}

function validatePhase(
  p: unknown,
  i: number,
  file: string,
): PhaseSpec {
  if (!p || typeof p !== "object") {
    throw new Error(`${file}: phases[${i}] is not an object`);
  }
  const pr = p as Record<string, unknown>;
  const components = pr.components;
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error(`${file}: phases[${i}].components must be non-empty`);
  }
  const reserved = reservedComponentNames();
  for (const c of components) {
    if (typeof c !== "string") {
      throw new Error(
        `${file}: phases[${i}].components has non-string entry`,
      );
    }
    if (c === "review" || c === "run-deferred-writer") {
      throw new Error(
        `${file}: phases[${i}] declares "${c}", which requires the ` +
          `RPC-delegator topology. Not runnable via delegate(). ` +
          `Use pi-agent-builder.`,
      );
    }
    if (reserved.has(c)) {
      throw new Error(
        `${file}: phases[${i}].components must not list "${c}" — ` +
          `auto-injected by the runner.`,
      );
    }
    if (!COMPONENTS[c]) {
      throw new Error(
        `${file}: phases[${i}] unknown component "${c}". ` +
          `Known: ${Object.keys(COMPONENTS).join(", ")}.`,
      );
    }
  }
  const promptRaw = pr.prompt;
  if (typeof promptRaw !== "string" || promptRaw.length === 0) {
    throw new Error(
      `${file}: phases[${i}].prompt must be a non-empty string`,
    );
  }
  const nameRaw = pr.name;

  let tools: string[] | undefined;
  if (pr.tools !== undefined) {
    if (
      !Array.isArray(pr.tools) ||
      pr.tools.length === 0 ||
      !pr.tools.every((t) => typeof t === "string" && t.length > 0)
    ) {
      throw new Error(
        `${file}: phases[${i}].tools must be a non-empty array of strings`,
      );
    }
    tools = pr.tools as string[];
    const declared = new Set<string>();
    for (const c of components as string[]) {
      const fixed = COMPONENTS[c]();
      for (const t of fixed.tools) declared.add(t);
    }
    const missing = [...declared].filter((t) => !tools!.includes(t));
    if (missing.length > 0) {
      throw new Error(
        `${file}: phases[${i}].tools is missing tools required by ` +
          `declared components: ${missing.join(", ")}. Either add them ` +
          `to the explicit list or drop the offending components.`,
      );
    }
  }

  return {
    name: typeof nameRaw === "string" ? nameRaw : undefined,
    components: components as string[],
    tools,
    prompt: promptRaw,
  };
}

function expectString(
  r: Record<string, unknown>,
  key: string,
  file: string,
): string {
  const v = r[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${file}: missing or non-string "${key}"`);
  }
  return v;
}
