// emit-agent-spec.ts — output channel for the pi-agent-composer skill.
//
// Loaded into a pi session via `pi -e <path>`. The default-exported
// factory registers `emit_agent_spec`, whose `execute()` writes a YAML
// spec to `<PI_SANDBOX_ROOT>/.pi/agents/<spec.name>.yml`. The composer's
// tool allowlist exposes ONLY `emit_agent_spec` plus sandbox_* read
// verbs, so the LLM has no other write channel; the tool's TypeBox
// schema IS the YAML spec shape, eliminating manual YAML formatting by
// the model.
//
// At runtime the file is read back by `.pi/extensions/yaml-agent-runner.ts`
// (auto-discovered when pi runs in `pi-sandbox/`), which globs
// `.pi/agents/*.yml` and registers one slash command per spec.
//
// **Approval gate (dual-mode).** Every emit goes through a user
// confirm before landing on disk. Branching is by `ctx.hasUI`:
//   - `ctx.hasUI === true` (interactive composer session, the default
//     `npm run agent-composer:i` entry): the child runs `ctx.ui.confirm`
//     inline, writes the YAML on approval, returns `isError: true`
//     with `details.cancelled: true` on denial. The LLM is expected
//     to ask the user what to revise on denial rather than silently
//     retrying with a different name.
//   - `ctx.hasUI === false` (sub-agent under delegate(), or print
//     mode `pi -p`): the child stages the YAML in `details` without
//     writing. The parent-side `finalize` harvests staged specs and
//     runs its own `confirm` via `fctx.ctx.ui.confirm`; if that side
//     also has no UI (true print-mode-all-the-way-up), all staged
//     specs are denied with reason `"no-ui"` — print mode without
//     a parent TUI is treated as "always cancel" per the deferred-
//     writer convention.
//
// The harvest+gate split lets a future orchestrator drive the
// composer through `delegate()` while keeping the same single-source-
// of-truth gate at whichever process owns the user's TUI.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { stringify as yamlStringify } from "yaml";
import { validate } from "./cwd-guard.ts";
import type {
  EmitAgentSpecResult,
  EmitAgentSpecState,
  NDJSONEvent,
  ParentSide,
} from "./_parent-side.ts";

const COMPONENT_NAMES = [
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

export default function (pi: ExtensionAPI) {
  const ROOT = process.env.PI_SANDBOX_ROOT;
  if (!ROOT) {
    throw new Error("emit-agent-spec.ts: PI_SANDBOX_ROOT must be set");
  }
  const ROOT_ABS = path.resolve(ROOT);
  const AGENTS_DIR = path.join(ROOT_ABS, ".pi", "agents");

  pi.registerTool({
    name: "emit_agent_spec",
    label: "Emit Agent Spec",
    description:
      "Emit a composed agent specification as a YAML file. Use this IN " +
      "PLACE of writing TypeScript by hand — you cannot author code in " +
      "this session, only declare a spec. The runner extension reads " +
      "the YAML and registers a slash command that wires the declared " +
      "components via delegate(). Call exactly once per agent. The " +
      "user previews the YAML and approves before it lands; treat " +
      "`isError: true` (with `details.cancelled: true`) as 'no spec " +
      "was written' and ASK the user what to change before re-emitting " +
      "(do NOT silently retry with a different name).",
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
                "Role-specific components the runner imports as " +
                "`parentSide` and passes to delegate(). DO NOT include " +
                "`cwd-guard` or `sandbox-fs` — they are auto-injected by " +
                "the runner (cwd-guard universally, sandbox-fs whenever " +
                "any sandbox_* verb appears in `tools`). List only the " +
                "stubs the role needs (`stage-write`, `emit-summary`, " +
                "etc.); pair with a `tools` list that picks the sandbox_* " +
                "verbs the role's child needs.",
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
    async execute(_id, params, _signal, _onUpdate, ctx) {
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
      // Defense-in-depth: route through cwd-guard's canonical
      // validator (lex + realpath) before mkdir+write. The lex check
      // above already restricts to AGENTS_DIR; validate() additionally
      // rejects symlink escapes (e.g. an in-bounds destReal that
      // resolves outside the sandbox via a symlinked subdir).
      validate(destReal, ROOT);
      if (fs.existsSync(destReal)) {
        throw new Error(
          `${params.name}.yml already exists. Pick a different name; ` +
            `existing specs are immutable in this session.`,
        );
      }

      const yaml = yamlStringify(params, { lineWidth: 0 });

      if (!ctx?.hasUI) {
        // Sub-agent or print-mode context. Don't write — return the
        // staged payload and let the parent (or the absence of one)
        // decide. ctx may be undefined when execute() is called outside
        // pi's tool dispatcher (older test harnesses, ad-hoc loaders);
        // treat that the same as "no UI", since there's no place to
        // confirm.
        return {
          content: [
            {
              type: "text",
              text:
                `Spec for ${params.name} staged for parent review. ` +
                `If this composer is running standalone (no orchestrator), ` +
                `nothing will be written.`,
            },
          ],
          details: {
            name: params.name,
            slash: params.slash,
            composition: params.composition,
            yaml,
            staged: true,
          },
        };
      }

      // Direct human session — gate inline.
      const ok = await ctx.ui.confirm(
        `Write composer spec to .pi/agents/${params.name}.yml?`,
        yaml,
      );
      if (!ok) {
        return {
          content: [
            {
              type: "text",
              text:
                "Cancelled by user. Spec was NOT written. Ask the user " +
                "what they would like to change, then re-emit the spec.",
            },
          ],
          details: {
            name: params.name,
            cancelled: true,
            reason: "denied",
            staged: false,
          },
          isError: true,
        };
      }

      fs.mkdirSync(AGENTS_DIR, { recursive: true });
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
          staged: false,
        },
      };
    },
  });
}

export function validateNames(name: string, slash: string): void {
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

export const COMPOSITION_NAMES = COMPOSITIONS;

export function validatePhases(
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

// Parent-side surface. Drives a child running this component via
// `delegate()` (or any hand-rolled spawn that loads `-e <this file>`).
// In-child execute() branches on `ctx.hasUI`: with UI it gates inline
// and writes; without UI it returns staged payload in `details`. The
// parent harvests `tool_execution_end` events:
//   - `details.staged === true`  → push to state.staged for the parent
//                                   to gate + write in finalize.
//   - `details.staged === false` → push to state.childWrote (the child
//                                   already wrote and confirmed; parent
//                                   reports it for logs).
//   - event.isError === true     → ignore (cancelled or threw; nothing
//                                   to report).
// Finalize iterates over staged specs sequentially through
// `fctx.ctx.ui.confirm`. Re-validates only fs-state (existsSync +
// path containment) — params shape is deterministic on values that
// don't change between child-validate and parent-finalize, so re-
// running regex/phase rules adds nothing. When the parent also has
// no UI (true print-mode-all-the-way-up), all staged specs are
// denied with reason `"no-ui"` and a notify warns the user.
const SELF_PATH = fileURLToPath(import.meta.url);

export const parentSide: ParentSide<EmitAgentSpecState, EmitAgentSpecResult> = {
  name: "emit-agent-spec",
  tools: ["emit_agent_spec"],
  spawnArgs: ["-e", SELF_PATH],
  env: ({ cwd }) => ({ PI_SANDBOX_ROOT: cwd }),
  initialState: () => ({ staged: [], childWrote: [] }),
  harvest: (event: NDJSONEvent, state: EmitAgentSpecState) => {
    if (event.type !== "tool_execution_end") return;
    if (event.toolName !== "emit_agent_spec") return;
    if (event.isError === true) return;
    const result = event.result as
      | { details?: Record<string, unknown> }
      | undefined;
    const details = result?.details;
    if (!details) return;
    if (details.staged === true) {
      const name = details.name;
      const slash = details.slash;
      const composition = details.composition;
      const yaml = details.yaml;
      if (
        typeof name === "string" &&
        typeof slash === "string" &&
        typeof composition === "string" &&
        typeof yaml === "string"
      ) {
        state.staged.push({ name, slash, composition, yaml });
      }
    } else if (details.staged === false && typeof details.path === "string") {
      const name = details.name;
      if (typeof name === "string") {
        state.childWrote.push({ name, path: details.path });
      }
    }
  },
  finalize: async (state, fctx) => {
    const result: EmitAgentSpecResult = {
      written: state.childWrote.map((w) => ({ name: w.name, path: w.path })),
      denied: [],
      errors: [],
    };

    if (state.staged.length === 0) return result;

    // Print mode all the way up — no parent UI to confirm. Cancel
    // everything and notify the user. Same convention as
    // delegate.ts:370's `!ctx.ui.confirm` path.
    if (fctx.ctx.hasUI === false || !fctx.ctx.ui.confirm) {
      fctx.ctx.ui.notify(
        `emit_agent_spec: ${state.staged.length} spec(s) staged but no UI to confirm; cancelled.`,
        "info",
      );
      for (const s of state.staged) {
        result.denied.push({ name: s.name, reason: "no-ui" });
      }
      return result;
    }

    const agentsRoot = path.join(fctx.sandboxRoot, ".pi", "agents");

    for (const spec of state.staged) {
      // Re-validate fs-state at the parent's truth boundary. Static
      // params-shape rules (name regex, phase rules) were already
      // run in the child and can't change in flight; existsSync
      // and the path-containment check both can.
      const dest = path.join(agentsRoot, `${spec.name}.yml`);
      const destReal = path.resolve(dest);
      if (
        destReal !== agentsRoot &&
        !destReal.startsWith(agentsRoot + path.sep)
      ) {
        result.errors.push({
          name: spec.name,
          reason: `path escapes agents dir: ${destReal}`,
        });
        continue;
      }
      try {
        validate(destReal, fctx.sandboxRoot);
      } catch (e) {
        result.errors.push({ name: spec.name, reason: (e as Error).message });
        continue;
      }
      if (fs.existsSync(destReal)) {
        result.errors.push({ name: spec.name, reason: "already exists" });
        continue;
      }

      const ok = await fctx.ctx.ui.confirm(
        `Write composer spec to .pi/agents/${spec.name}.yml?`,
        spec.yaml,
      );
      if (!ok) {
        result.denied.push({ name: spec.name, reason: "denied" });
        continue;
      }

      try {
        fs.mkdirSync(path.dirname(destReal), { recursive: true });
        fs.writeFileSync(destReal, spec.yaml, "utf8");
        result.written.push({ name: spec.name, path: destReal });
      } catch (e) {
        result.errors.push({ name: spec.name, reason: (e as Error).message });
      }
    }

    return result;
  },
};
