// agent-spawn extension — blocking delegation to a focused child agent.
// Registers the `delegate` tool, which spawns `node scripts/run-agent.mjs
// <recipe> -p <task>` as a subprocess, captures stdout, and returns when
// the child exits. The child runs through the same runner as a normal
// `npm run agent` invocation, so it gets the full baseline rails
// (sandbox, no-edit if the recipe loads it, etc).
//
// Companion to agent-bus (async peer messaging). Delegation is
// ephemeral, anonymous, and structured-return; it does NOT use the bus.
// A recipe that wants both delegation and peer messaging loads both
// extensions independently.
//
// Why subprocess and not in-process createAgentSession: the parent's
// extension surface (including agent-bus's socket binding) would re-fire
// session_start for the child, causing name collisions and shared
// globalThis state. Subprocess gives clean isolation at the cost of
// startup latency.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const RUNNER_PATH = path.join(REPO_ROOT, "scripts", "run-agent.mjs");
const AGENTS_DIR = path.join(REPO_ROOT, "pi-sandbox", "agents");

const MAX_OUTPUT_BYTES = 20_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Spawn a child agent from a recipe in pi-sandbox/agents/, hand it a " +
      "task, and block until it exits. Returns the child's captured stdout " +
      "(truncated to 20KB). Ephemeral and anonymous: the child has no name " +
      "on the bus and dies after the call. Use this for focused subtasks " +
      "where you want a structured result; use agent_send for long-lived " +
      "peer coordination.",
    parameters: Type.Object({
      recipe: Type.String({
        description: "Name of a recipe in pi-sandbox/agents/ (without .yaml suffix).",
      }),
      task: Type.String({
        description: "The task prompt handed to the child as its first user message.",
      }),
      sandbox: Type.Optional(
        Type.String({
          description: "Optional sandbox root for the child. Defaults to the parent's sandbox root.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description: `Max child runtime in ms before SIGTERM. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const recipeFile = path.join(AGENTS_DIR, `${params.recipe}.yaml`);
      if (!existsSync(recipeFile)) {
        return {
          content: [{ type: "text", text: `delegate: recipe not found: ${recipeFile}` }],
          details: { error: "recipe_not_found", recipe: params.recipe },
        };
      }
      if (!existsSync(RUNNER_PATH)) {
        return {
          content: [{ type: "text", text: `delegate: runner missing: ${RUNNER_PATH}` }],
          details: { error: "runner_missing" },
        };
      }

      // pi.getFlag is scoped to the calling extension, so we can't read
      // sandbox-root cross-extension. ctx.cwd works because the runner
      // spawns pi with cwd=sandboxRoot.
      const sandboxRoot = path.resolve(params.sandbox || ctx?.cwd || process.cwd());
      const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : DEFAULT_TIMEOUT_MS;

      const args = [RUNNER_PATH, params.recipe, "--sandbox", sandboxRoot, "-p", params.task];

      const child = spawn(process.execPath, args, {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let truncated = false;

      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        const s = chunk.toString("utf8");
        if (target === "stdout") {
          if (stdout.length + s.length > MAX_OUTPUT_BYTES) {
            stdout += s.slice(0, MAX_OUTPUT_BYTES - stdout.length);
            truncated = true;
          } else {
            stdout += s;
          }
        } else {
          if (stderr.length < MAX_OUTPUT_BYTES) {
            stderr += s.slice(0, MAX_OUTPUT_BYTES - stderr.length);
          }
        }
      };
      child.stdout?.on("data", (c: Buffer) => append("stdout", c));
      child.stderr?.on("data", (c: Buffer) => append("stderr", c));

      const onAbort = () => {
        if (!child.killed) child.kill("SIGTERM");
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
      }, timeoutMs);

      const exit: { code: number | null; signal: NodeJS.Signals | null } = await new Promise((resolve) => {
        child.once("exit", (code, sig) => resolve({ code, signal: sig }));
      });

      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      const tail = truncated ? "\n…(output truncated)" : "";
      const text = stdout.length > 0 ? `${stdout}${tail}` : stderr || "(no output)";

      return {
        content: [{ type: "text", text }],
        details: {
          recipe: params.recipe,
          exit_code: exit.code,
          exit_signal: exit.signal,
          stdout_bytes: stdout.length,
          stderr_bytes: stderr.length,
          truncated,
        },
      };
    },
  });
}
