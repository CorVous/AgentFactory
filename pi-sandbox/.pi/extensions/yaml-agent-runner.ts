// yaml-agent-runner.ts — auto-discovered runtime for YAML agent specs
// emitted by the pi-agent-composer skill.
//
// On extension load, globs `.pi/agents/*.yml` (relative to pi's cwd, which
// is `pi-sandbox/` for every npm-script entry point), parses each, and
// registers one slash command per spec. Each handler dispatches the
// declared phases via `delegate()` from `../lib/delegate.ts`, mapping
// component names to the canonical `parentSide` exports. For
// `sequential-phases-with-brief`, the runner harvests phase-1
// `emit_summary` calls into a bounded brief and substitutes it into
// phase-2's prompt as `{brief}`.
//
// Orchestrator topology (rpc-delegator-over-concurrent-drafters) is NOT
// runnable here — `delegate()` is single-spawn json-mode only. Specs
// declaring it (or hand-edited specs requesting `review` /
// `run-deferred-writer` components) are rejected at registration with a
// pointer to pi-agent-builder. The composer's `emit_agent_spec` enforces
// the same rule at write time; this is defense in depth for hand edits.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parse as yamlParse } from "yaml";
import { parentSide as CWD_GUARD } from "../components/cwd-guard.ts";
import { parentSide as EMIT_AGENT_SPEC } from "../components/emit-agent-spec.ts";
import { parentSide as EMIT_SUMMARY } from "../components/emit-summary.ts";
import { parentSide as STAGE_WRITE } from "../components/stage-write.ts";
import type { EmitSummaryResult, ParentSide } from "../components/_parent-side.ts";
import { delegate } from "../lib/delegate.ts";

const AGENTS_DIR = path.resolve(process.cwd(), ".pi", "agents");
export const MAX_BRIEF_BYTES = 16_000;

// Static name → parentSide map. Kept to the components a single-spawn or
// sequential-phases-with-brief runner can actually drive: cwd-guard,
// stage-write, emit-summary, emit-agent-spec. Adding `review` /
// `run-deferred-writer` here would not make them work — `delegate()`
// doesn't manage the RPC loop they require — so they are rejected at
// validation time instead (see `validateSpec`).
const COMPONENTS: Record<string, ParentSide<any, unknown>> = {
  "cwd-guard": CWD_GUARD,
  "stage-write": STAGE_WRITE,
  "emit-summary": EMIT_SUMMARY,
  "emit-agent-spec": EMIT_AGENT_SPEC,
};

export interface PhaseSpec {
  name?: string;
  components: string[];
  /** Optional explicit child --tools allowlist for this phase. When set,
   *  becomes the child's tool surface verbatim (passed through delegate's
   *  `toolsOverride`). When omitted, delegate unions the components'
   *  declared tools. The validator requires every component's declared
   *  tools to be present in this list when set. */
  tools?: string[];
  prompt: string;
}

export interface AgentSpec {
  name: string;
  slash: string;
  description: string;
  composition: "single-spawn" | "sequential-phases-with-brief";
  /** Optional skill path; passed as `--skill <path>` (with `--no-skills`
   *  for override semantics) on every phase's child spawn. Resolved
   *  relative to pi's cwd (the sandbox root) at registration time. */
  skill?: string;
  phases: PhaseSpec[];
}

export default function (pi: ExtensionAPI) {
  if (!fs.existsSync(AGENTS_DIR)) return;

  const files = fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();

  for (const file of files) {
    const abs = path.join(AGENTS_DIR, file);
    let spec: AgentSpec;
    try {
      const raw = fs.readFileSync(abs, "utf8");
      spec = validateSpec(yamlParse(raw), file);
    } catch (e) {
      console.warn(
        `[yaml-agent-runner] skipping ${file}: ${(e as Error).message}`,
      );
      continue;
    }

    pi.registerCommand(spec.slash, {
      description: spec.description,
      handler: async (args, ctx) => {
        if (!args.trim()) {
          ctx.ui.notify(
            `Usage: /${spec.slash} <task description>`,
            "warning",
          );
          return;
        }
        const sandboxRoot = path.resolve(process.cwd());
        const baseSubs = { args: args.trim(), sandboxRoot };

        if (spec.composition === "single-spawn") {
          const phase = spec.phases[0];
          await delegate(ctx, {
            components: phase.components.map((n) => COMPONENTS[n]),
            prompt: substitute(phase.prompt, baseSubs),
            skill: spec.skill,
            toolsOverride: phase.tools,
          });
          return;
        }

        // sequential-phases-with-brief
        const scoutPhase = spec.phases[0];
        const draftPhase = spec.phases[1];
        const scoutResult = await delegate(ctx, {
          components: scoutPhase.components.map((n) => COMPONENTS[n]),
          prompt: substitute(scoutPhase.prompt, baseSubs),
          skill: spec.skill,
          toolsOverride: scoutPhase.tools,
        });
        const summaries =
          (scoutResult.byComponent.get("emit-summary") as
            | EmitSummaryResult
            | undefined)?.summaries ?? [];
        if (summaries.length === 0) {
          ctx.ui.notify(
            "scout phase emitted no summaries; aborting before drafter",
            "error",
          );
          return;
        }
        const brief = buildBrief(summaries);
        if (Buffer.byteLength(brief, "utf8") > MAX_BRIEF_BYTES) {
          ctx.ui.notify(
            `brief is ${Buffer.byteLength(brief, "utf8")} bytes > ${MAX_BRIEF_BYTES} budget; aborting`,
            "error",
          );
          return;
        }
        await delegate(ctx, {
          components: draftPhase.components.map((n) => COMPONENTS[n]),
          prompt: substitute(draftPhase.prompt, { ...baseSubs, brief }),
          skill: spec.skill,
          toolsOverride: draftPhase.tools,
        });
      },
    });
  }
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
 * Concatenate scout-phase summaries into a `## title\nbody` block. The
 * caller is responsible for byte-budget enforcement via MAX_BRIEF_BYTES;
 * this helper is purely formatting so it can be unit tested without the
 * surrounding handler.
 */
export function buildBrief(
  summaries: ReadonlyArray<{ title: string; body: string }>,
): string {
  return summaries.map((s) => `## ${s.title}\n${s.body}`).join("\n\n");
}

export function validateSpec(raw: unknown, file: string): AgentSpec {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${file}: not an object`);
  }
  const r = raw as Record<string, unknown>;
  const name = expectString(r, "name", file);
  const slash = expectString(r, "slash", file);
  const description = expectString(r, "description", file);
  const composition = expectString(r, "composition", file);
  if (
    composition !== "single-spawn" &&
    composition !== "sequential-phases-with-brief"
  ) {
    throw new Error(
      `${file}: composition "${composition}" not runnable here. ` +
        `Only single-spawn and sequential-phases-with-brief are supported. ` +
        `Use pi-agent-builder for orchestrator topologies.`,
    );
  }
  const phasesRaw = r.phases;
  if (!Array.isArray(phasesRaw) || phasesRaw.length === 0) {
    throw new Error(`${file}: phases must be a non-empty array`);
  }
  const phases: PhaseSpec[] = phasesRaw.map((p, i) => {
    if (!p || typeof p !== "object") {
      throw new Error(`${file}: phases[${i}] is not an object`);
    }
    const pr = p as Record<string, unknown>;
    const components = pr.components;
    if (!Array.isArray(components) || components.length === 0) {
      throw new Error(`${file}: phases[${i}].components must be non-empty`);
    }
    for (const c of components) {
      if (typeof c !== "string") {
        throw new Error(`${file}: phases[${i}].components has non-string entry`);
      }
      if (c === "review" || c === "run-deferred-writer") {
        throw new Error(
          `${file}: phases[${i}] declares "${c}", which requires the ` +
            `RPC-delegator topology. Not runnable via delegate(). ` +
            `Use pi-agent-builder.`,
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
      throw new Error(`${file}: phases[${i}].prompt must be a non-empty string`);
    }
    const nameRaw = pr.name;

    // Optional explicit tools allowlist. When set, must be a non-empty
    // string array AND must cover every tool each declared component
    // contributes — otherwise a typo silently strips a component's
    // ability to do its job.
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
        for (const t of COMPONENTS[c].tools) declared.add(t);
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
  });

  if (composition === "single-spawn" && phases.length !== 1) {
    throw new Error(
      `${file}: single-spawn requires exactly 1 phase, got ${phases.length}`,
    );
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

  // Optional skill — string path resolved against pi's cwd (sandbox root).
  // Required to be an existing directory if set.
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
