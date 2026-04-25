// emit-agent-spec.ts — output channel for the pi-agent-composer skill.
//
// Loaded into a pi session via `pi -e <path>`. The default-exported
// factory does two things on every load:
//  1. Registers `emit_agent_spec`, whose `execute()` writes a YAML spec
//     to `<PI_SANDBOX_ROOT>/.pi/agents/<spec.name>.yml`. The tool's
//     TypeBox schema IS the YAML spec shape, eliminating manual YAML
//     formatting by the model.
//  2. Subscribes to `before_agent_start` and injects the composer
//     skill catalog into the system prompt — the same XML
//     `<available_skills>` block pi would generate from
//     `--skill skills/pi-agent-composer`. This means loading this
//     extension is sufficient to "be" the composer; callers no longer
//     need to pass `--skill` separately. Same path runs in interactive
//     parents and delegate-spawned children, since `before_agent_start`
//     fires in every pi mode (agent-session.js:761).
//
// At runtime the file is read back by `.pi/extensions/yaml-agent-runner.ts`
// (auto-discovered when pi runs in `pi-sandbox/`), which globs
// `.pi/agents/*.yml` and registers one slash command per spec.
//
// Also exports a `parentSide` so `delegate()` can drive a child that
// needs `emit_agent_spec`. The runner imports this parentSide, then
// `delegate()` spawns a child pi with `-e <this file>` — the child LLM
// calls the tool whose `execute()` writes the YAML on disk. The parent
// harvests `tool_execution_start` for logging only; the actual success
// signal is the file existing on disk after the child exits.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { stringify as yamlStringify } from "yaml";
import type {
  EmitAgentSpecResult,
  EmitAgentSpecState,
  NDJSONEvent,
  ParentSide,
} from "./_parent-side.ts";

const COMPONENT_NAMES = [
  "cwd-guard",
  "stage-write",
  "emit-summary",
  "review",
  "run-deferred-writer",
  "emit-agent-spec",
] as const;

const COMPOSITIONS = [
  "single-spawn",
  "sequential-phases-with-brief",
] as const;

const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const SLASH_RE = /^[a-z][a-z0-9-]{1,40}$/;

// Compute the composer skill catalog block once at module load. Same
// shape pi produces for `--skill <dir>`: an `<available_skills>` XML
// block listing the skill name, description, and on-disk location.
// LLM reads SKILL.md (and subfiles) on demand via its `read` tool.
const SKILL_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
  "pi-agent-composer",
);
const SKILL_BLOCK = (() => {
  if (!fs.existsSync(SKILL_DIR)) return "";
  const { skills } = loadSkillsFromDir({
    dir: SKILL_DIR,
    source: "extension:emit-agent-spec",
  });
  return formatSkillsForPrompt(skills);
})();

export default function (pi: ExtensionAPI) {
  const ROOT = process.env.PI_SANDBOX_ROOT;
  if (!ROOT) {
    throw new Error("emit-agent-spec.ts: PI_SANDBOX_ROOT must be set");
  }
  const ROOT_ABS = path.resolve(ROOT);
  const AGENTS_DIR = path.join(ROOT_ABS, ".pi", "agents");

  if (SKILL_BLOCK) {
    // Append the composer skill catalog to every turn's system prompt.
    // Fires in interactive REPL parents and in delegate-spawned `-p`
    // children alike (agent-session.js:761 emits unconditionally).
    pi.on("before_agent_start", (event) => ({
      systemPrompt: event.systemPrompt + SKILL_BLOCK,
    }));
  }

  pi.registerTool({
    name: "emit_agent_spec",
    label: "Emit Agent Spec",
    description:
      "Emit a composed agent specification as a YAML file. Use this IN " +
      "PLACE of writing TypeScript by hand — you cannot author code in " +
      "this session, only declare a spec. The runner extension reads " +
      "the YAML and registers a slash command that wires the declared " +
      "components via delegate(). Call exactly once per agent.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Spec filename (no extension, no path). Lowercase letters, " +
          "digits, dashes; 2-41 chars. Becomes `.pi/agents/<name>.yml`.",
      }),
      slash: Type.String({
        description:
          "Slash command the runner will register, without leading `/`. " +
          "Lowercase letters, digits, dashes; 2-41 chars.",
      }),
      description: Type.String({
        description:
          "One-line description shown in pi's slash-command help. " +
          "Keep under 120 chars.",
      }),
      composition: StringEnum(COMPOSITIONS as unknown as string[], {
        description:
          "`single-spawn` for one child phase. " +
          "`sequential-phases-with-brief` for a 2-phase scout→draft flow " +
          "where the runner assembles a brief from phase-1 emit_summary " +
          "calls and substitutes it into phase-2's prompt as `{brief}`. " +
          "Orchestrator (RPC delegator) is NOT supported here — emit GAP " +
          "for those asks.",
      }),
      phases: Type.Array(
        Type.Object({
          name: Type.Optional(
            Type.String({
              description:
                "Optional phase label for logs (e.g. `scout`, `draft`).",
            }),
          ),
          components: Type.Array(
            StringEnum(COMPONENT_NAMES as unknown as string[]),
            {
              description:
                "Components the runner imports as `parentSide` and passes " +
                "to delegate(). cwd-guard is implicit for any write-capable " +
                "phase but should still be listed explicitly.",
              minItems: 1,
              maxItems: 5,
            },
          ),
          prompt: Type.String({
            description:
              "Prompt sent to the child for this phase. Supports template " +
              "variables: `{args}` (the slash-command argument the user " +
              "passes at runtime) and `{sandboxRoot}` (absolute path of " +
              "the pi-sandbox cwd). For phase 2 of " +
              "sequential-phases-with-brief, also `{brief}` (the assembled " +
              "phase-1 summaries).",
          }),
        }),
        { minItems: 1, maxItems: 2 },
      ),
    }),
    async execute(_id, params) {
      validateNames(params.name, params.slash);
      validatePhases(
        params.composition as (typeof COMPOSITIONS)[number],
        params.phases,
      );

      const dest = path.join(AGENTS_DIR, `${params.name}.yml`);
      const destReal = path.resolve(dest);
      if (
        destReal !== AGENTS_DIR &&
        !destReal.startsWith(AGENTS_DIR + path.sep)
      ) {
        throw new Error(
          `path escapes agents dir: ${params.name} -> ${destReal}`,
        );
      }
      if (fs.existsSync(destReal)) {
        throw new Error(
          `${params.name}.yml already exists. Pick a different name; ` +
            `existing specs are immutable in this session.`,
        );
      }

      fs.mkdirSync(AGENTS_DIR, { recursive: true });
      const yaml = yamlStringify(params, { lineWidth: 0 });
      fs.writeFileSync(destReal, yaml, "utf8");

      return {
        content: [
          {
            type: "text",
            text:
              `Wrote spec to .pi/agents/${params.name}.yml. ` +
              `Restart pi to register /${params.slash}.`,
          },
        ],
        details: {
          name: params.name,
          path: destReal,
          composition: params.composition,
        },
      };
    },
  });
}

function validateNames(name: string, slash: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `name must match ${NAME_RE} (lowercase + digits + dash, 2-41 chars): ${name}`,
    );
  }
  if (!SLASH_RE.test(slash)) {
    throw new Error(
      `slash must match ${SLASH_RE} (lowercase + digits + dash, 2-41 chars): ${slash}`,
    );
  }
}

function validatePhases(
  composition: (typeof COMPOSITIONS)[number],
  phases: ReadonlyArray<{ components: string[] }>,
): void {
  for (const p of phases) {
    if (p.components.includes("review") || p.components.includes("run-deferred-writer")) {
      throw new Error(
        "review and run-deferred-writer require the rpc-delegator " +
          "topology, which the YAML composer does not cover. Emit a GAP " +
          "message and instruct the user to load pi-agent-builder.",
      );
    }
  }
  if (composition === "single-spawn") {
    if (phases.length !== 1) {
      throw new Error(
        `single-spawn requires exactly 1 phase, got ${phases.length}`,
      );
    }
    return;
  }
  if (composition === "sequential-phases-with-brief") {
    if (phases.length !== 2) {
      throw new Error(
        `sequential-phases-with-brief requires exactly 2 phases, got ${phases.length}`,
      );
    }
    if (!phases[0].components.includes("emit-summary")) {
      throw new Error(
        "sequential-phases-with-brief: phase 1 must include `emit-summary` " +
          "(the brief is built from its harvested summaries).",
      );
    }
    if (!phases[1].components.includes("stage-write")) {
      throw new Error(
        "sequential-phases-with-brief: phase 2 must include `stage-write` " +
          "(the brief is consumed by a drafter).",
      );
    }
    return;
  }
  throw new Error(`unknown composition: ${composition}`);
}

// Parent-side surface. `delegate()` uses this to drive a child that needs
// `emit_agent_spec` — used by the self-hosted agent-composer YAML. The
// child is spawned with `-e <this file>` so the same default factory
// above runs in the child and registers the tool there; the child LLM's
// call writes the YAML directly. Parent only records the call site for
// logs; finalize verifies the on-disk file exists as the success signal.
const SELF_PATH = fileURLToPath(import.meta.url);

export const parentSide: ParentSide<EmitAgentSpecState, EmitAgentSpecResult> = {
  name: "emit-agent-spec",
  tools: ["emit_agent_spec"],
  spawnArgs: ["-e", SELF_PATH],
  env: ({ cwd }) => ({ PI_SANDBOX_ROOT: cwd }),
  initialState: () => ({ wrote: false, name: undefined }),
  harvest: (event: NDJSONEvent, state: EmitAgentSpecState) => {
    if (event.type !== "tool_execution_start") return;
    if (event.toolName !== "emit_agent_spec") return;
    const args = event.args as { name?: unknown } | undefined;
    state.wrote = true;
    if (args && typeof args.name === "string") state.name = args.name;
  },
  finalize: (state, fctx) => {
    if (!state.wrote || !state.name) {
      return { wrote: false, name: state.name };
    }
    const dest = path.join(fctx.sandboxRoot, ".pi", "agents", `${state.name}.yml`);
    return { wrote: fs.existsSync(dest), name: state.name };
  },
};
