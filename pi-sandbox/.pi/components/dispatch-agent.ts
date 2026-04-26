// dispatch-agent.ts — orchestrator stub for the agent-calls-agent
// dispatcher topology. The child registers `dispatch_agent({name,
// args})` as a no-op stub; the parent harvests each call from the
// NDJSON `tool_execution_start` stream and runs the actual dispatch
// in `finalize`.
//
// `name` resolves in two layers:
//   - "composer"  → the special meta-composer entry. Spawns pi with
//     the pi-agent-composer skill plus the emit-agent-spec component,
//     same shape as `scripts/agent-composer.sh` does for the user-
//     facing entry. Lets a dispatcher LLM ask the composer to design
//     a brand-new sub-agent on demand; the composer's YAML confirm
//     dialog renders in whichever process owns the user's TUI
//     (typically the user's interactive pi session several layers up).
//   - any other string → looked up against
//     `<sandboxRoot>/.pi/agents/<name>.yml`. The YAML is parsed,
//     validated, and run via `runSpec` — same code path as the
//     user-facing slash dispatch in yaml-agent-runner.ts.
//
// `delegate()`'s ctx is threaded through every dispatched run, so
// any nested gate (stage_write confirms, emit_agent_spec confirms,
// even another dispatch-agent's gates) renders in the original
// user's TUI regardless of how deep the dispatch chain goes.
//
// **In v1, dispatcher-dispatching-dispatcher works** (dispatch-agent
// is a registered component) but is untested; the motivating use
// cases (composer fan-out, drafter fan-out) are flat. Don't rely on
// nested orchestration without adding a test case.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { parse as yamlParse } from "yaml";

import { validate } from "./cwd-guard.ts";
import type {
  DispatchAgentResult,
  DispatchAgentState,
  DispatchedAgentOutcome,
  NDJSONEvent,
  ParentSide,
  UiCtx,
} from "./_parent-side.ts";

const SELF_PATH = fileURLToPath(import.meta.url);

/**
 * Special name reserved for dispatching the pi-agent-composer skill.
 * The dispatcher LLM uses this to ask the composer to design a new
 * sub-agent. Distinct from any YAML filename so a real agent named
 * "composer" cannot collide.
 */
const COMPOSER_VIRTUAL_NAME = "composer";

const COMPOSER_TOOLS = [
  "sandbox_read",
  "sandbox_ls",
  "sandbox_grep",
  "emit_agent_spec",
];

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description:
      "Programmatically dispatch another emitted agent (looked up by " +
      "its YAML filename stem under .pi/agents/) or the special " +
      "virtual entry `composer` (which runs the pi-agent-composer " +
      "skill the same way the user-facing entry does). The dispatched " +
      "agent's gates (stage_write confirms, emit_agent_spec confirms) " +
      "render in the user's TUI as if the user had run the agent " +
      "directly. Each call dispatches once; you'll see the aggregated " +
      "result in the next assistant message. Available agent names " +
      "depend on what's currently in .pi/agents/; an unknown name " +
      "returns an error result with the available list.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Either an agent's YAML filename stem (e.g. `my-drafter` for " +
          "`.pi/agents/my-drafter.yml`) or the literal string `composer` " +
          "to invoke the pi-agent-composer skill.",
      }),
      args: Type.String({
        description:
          "Verbatim argument string forwarded to the dispatched agent. " +
          "For YAML agents, becomes the `{args}` template substitution " +
          "in each phase prompt. For the composer, becomes the natural-" +
          "language description of the agent to design.",
      }),
    }),
    async execute(_id, params) {
      return {
        content: [
          {
            type: "text",
            text:
              `Dispatched ${params.name}. Parent will run the agent and ` +
              `report the result here in the next message.`,
          },
        ],
        details: {
          name: params.name,
          args: params.args,
          dispatched: true,
        },
      };
    },
  });
}

// Parent-side surface. Imports runSpec lazily via the static import
// below — the cyclic dep with dispatch-spec.ts (which imports this
// file's parentSide) is broken by ESM live bindings: the runSpec
// reference is captured at module init, but invoked only inside
// finalize at runtime, by which time both modules are fully loaded.
import { runSpec, validateSpec } from "../lib/dispatch-spec.ts";

export const parentSide: ParentSide<
  DispatchAgentState,
  DispatchAgentResult
> = {
  name: "dispatch-agent",
  tools: ["dispatch_agent"],
  spawnArgs: ["-e", SELF_PATH],
  env: () => ({}),
  initialState: () => ({ requests: [] }),
  harvest: (event: NDJSONEvent, state: DispatchAgentState) => {
    if (event.type !== "tool_execution_start") return;
    if (event.toolName !== "dispatch_agent") return;
    const args = event.args as { name?: unknown; args?: unknown } | undefined;
    if (!args) return;
    state.requests.push({ name: args.name, args: args.args });
  },
  finalize: async (state, fctx) => {
    const dispatches: DispatchedAgentOutcome[] = [];
    for (const req of state.requests) {
      const dispatchedName =
        typeof req.name === "string" ? req.name : `<${typeof req.name}>`;
      const dispatchedArgs = typeof req.args === "string" ? req.args : "";

      if (typeof req.name !== "string" || req.name.length === 0) {
        dispatches.push({
          name: dispatchedName,
          args: dispatchedArgs,
          ok: false,
          summary: `dispatch_agent: invalid name (type=${typeof req.name})`,
        });
        continue;
      }

      if (req.name === COMPOSER_VIRTUAL_NAME) {
        dispatches.push(
          await runComposer(fctx.ctx, dispatchedArgs, fctx.sandboxRoot),
        );
        continue;
      }

      const outcome = await dispatchYamlAgent(
        fctx.ctx,
        req.name,
        dispatchedArgs,
        fctx.sandboxRoot,
      );
      dispatches.push(outcome);
    }
    return { dispatches };
  },
};

async function dispatchYamlAgent(
  ctx: UiCtx,
  name: string,
  args: string,
  sandboxRoot: string,
): Promise<DispatchedAgentOutcome> {
  const agentsDir = path.join(sandboxRoot, ".pi", "agents");
  const specPath = path.join(agentsDir, `${name}.yml`);
  const specPathReal = path.resolve(specPath);
  // Defense in depth: the LLM-supplied `name` is interpolated into
  // the path. cwd-guard's validate() rejects any path that escapes
  // sandboxRoot via lex+realpath containment.
  try {
    validate(specPathReal, sandboxRoot);
  } catch (e) {
    return {
      name,
      args,
      ok: false,
      summary: `dispatch_agent: ${name} → ${(e as Error).message}`,
    };
  }
  if (
    specPathReal !== agentsDir &&
    !specPathReal.startsWith(agentsDir + path.sep)
  ) {
    return {
      name,
      args,
      ok: false,
      summary: `dispatch_agent: ${name} resolves outside .pi/agents/`,
    };
  }
  if (!fs.existsSync(specPathReal)) {
    const available = listAvailableAgents(agentsDir);
    return {
      name,
      args,
      ok: false,
      summary:
        `dispatch_agent: no such agent "${name}". ` +
        `Available: ${available.length > 0 ? available.join(", ") : "(none)"}` +
        (available.length > 0
          ? ` (or the special name "${COMPOSER_VIRTUAL_NAME}")`
          : ` (or the special name "${COMPOSER_VIRTUAL_NAME}")`),
    };
  }

  let raw: unknown;
  try {
    raw = yamlParse(fs.readFileSync(specPathReal, "utf8"));
  } catch (e) {
    return {
      name,
      args,
      ok: false,
      summary: `dispatch_agent: ${name}.yml parse error: ${(e as Error).message}`,
    };
  }
  let spec;
  try {
    spec = validateSpec(raw, `${name}.yml`);
  } catch (e) {
    return {
      name,
      args,
      ok: false,
      summary: `dispatch_agent: ${name}.yml invalid: ${(e as Error).message}`,
    };
  }

  let result;
  try {
    result = await runSpec(ctx, spec, args);
  } catch (e) {
    return {
      name,
      args,
      ok: false,
      summary: `dispatch_agent: ${name} threw: ${(e as Error).message}`,
    };
  }

  const summary =
    `dispatched ${name}: promoted=${result.promotedCount}, ` +
    `phases=${result.phases.length}, cost=$${result.totalCost.toFixed(4)}` +
    (result.errors.length > 0 ? `, errors=${result.errors.length}` : "");
  return {
    name,
    args,
    ok: result.errors.length === 0,
    summary,
    details: {
      promotedCount: result.promotedCount,
      totalCost: result.totalCost,
      phases: result.phases.length,
      errors: result.errors,
    },
  };
}

async function runComposer(
  ctx: UiCtx,
  args: string,
  sandboxRoot: string,
): Promise<DispatchedAgentOutcome> {
  if (args.trim().length === 0) {
    return {
      name: COMPOSER_VIRTUAL_NAME,
      args,
      ok: false,
      summary:
        "composer dispatch needs a non-empty `args` describing the agent to design.",
    };
  }
  const skillDir = path.join(sandboxRoot, "skills", "pi-agent-composer");
  if (!fs.existsSync(skillDir)) {
    return {
      name: COMPOSER_VIRTUAL_NAME,
      args,
      ok: false,
      summary: `composer skill not found at ${skillDir}`,
    };
  }

  const wrapped = `Use the pi-agent-composer skill to: ${args.trim()}.`;

  // Lazy import to avoid the cyclic dep at module init time.
  const { delegate } = await import("../lib/delegate.ts");
  const { parentSide: EMIT_AGENT_SPEC } = await import("./emit-agent-spec.ts");

  let result;
  try {
    result = await delegate(ctx, {
      components: [EMIT_AGENT_SPEC],
      prompt: wrapped,
      skill: skillDir,
      toolsOverride: COMPOSER_TOOLS,
    });
  } catch (e) {
    return {
      name: COMPOSER_VIRTUAL_NAME,
      args,
      ok: false,
      summary: `composer dispatch threw: ${(e as Error).message}`,
    };
  }

  const emitResult = result.byComponent.get("emit-agent-spec") as
    | { written: Array<{ name: string }>; denied: Array<{ name: string }>; errors: Array<{ name: string }> }
    | undefined;
  const written = emitResult?.written ?? [];
  const denied = emitResult?.denied ?? [];
  const errors = emitResult?.errors ?? [];

  const summary =
    `composer: wrote=${written.length} ` +
    `(${written.map((w) => w.name).join(",") || "—"}), ` +
    `denied=${denied.length}, errors=${errors.length}, ` +
    `cost=$${result.costUsd.toFixed(4)}`;

  return {
    name: COMPOSER_VIRTUAL_NAME,
    args,
    ok: written.length > 0,
    summary,
    details: {
      written: written.map((w) => w.name),
      denied: denied.map((d) => d.name),
      errors: errors.map((e) => e.name),
      cost: result.costUsd,
    },
  };
}

/** Return YAML filename stems under `<agentsDir>`. Empty when the
 *  directory doesn't exist or contains no specs. Used to build the
 *  "no such agent: X. Available: …" error message. */
function listAvailableAgents(agentsDir: string): string[] {
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => f.replace(/\.(yml|yaml)$/, ""))
    .sort();
}
