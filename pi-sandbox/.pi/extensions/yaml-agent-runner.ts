// yaml-agent-runner.ts — auto-discovered runtime for YAML agent specs
// emitted by the pi-agent-composer skill.
//
// On extension load, globs `.pi/agents/*.yml` (relative to pi's cwd, which
// is `pi-sandbox/` for every npm-script entry point), parses each, and
// registers one slash command per spec. Each handler dispatches the
// declared phases via `runSpec` from `../lib/dispatch-spec.ts`, which
// wraps `delegate()` for each composition:
//   - single-spawn — one phase
//   - sequential-phases-with-brief — phase-1 emit_summary builds a brief
//     for phase-2's prompt as `{brief}`
//   - single-spawn-with-dispatch — dispatcher LLM with `dispatch_agent`
//     can programmatically invoke other emitted agents (or the composer)
//
// Per-spec dispatch logic lives in `../lib/dispatch-spec.ts` so the
// dispatch-agent component (the agent-calls-agent path) can reuse it
// without duplicating per-composition wiring. This file is now a thin
// glob+register layer.
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
import {
  runSpec,
  validateSpec,
  type AgentSpec,
} from "../lib/dispatch-spec.ts";

// Re-export shared helpers under their old names so external test
// files keep importing from here. The implementations now live in
// dispatch-spec.ts; this module is a thin registration layer.
export {
  buildBrief,
  MAX_BRIEF_BYTES,
  substitute,
  validateSpec,
  type AgentSpec,
  type PhaseSpec,
} from "../lib/dispatch-spec.ts";

const AGENTS_DIR = path.resolve(process.cwd(), ".pi", "agents");

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
        await runSpec(ctx, spec, args.trim());
      },
    });
  }
}
