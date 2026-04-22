# Sub-agent recipe

A **sub-agent** is a child pi session spawned to handle a self-contained task. The parent calls it as a tool; the child runs with its own context window and returns a result. This is how pi supports complex, parallel, or specialized workflows without bloating the parent's context.

Pi ships no sub-agent by default. You either build your own extension or install one (`nicobailon/pi-subagents`, `mjakl/pi-subagent`, etc.). The patterns below apply whichever route you take.

## When to use a sub-agent vs a plain tool

Use a **sub-agent** when:

- The task can be described in one prompt and run to completion without further user input.
- The work involves many steps or tool calls that would pollute the parent's context (codebase recon, security audit, large refactor).
- You want **parallelism** — multiple independent sub-tasks at once.
- You want to use a **different model** for this slice (cheap Haiku for recon, strong Sonnet for the main thread).

Use a **plain tool** when:

- The work is a single action (deploy, query, compute).
- The output is small and you want it directly in the parent's context.
- You need the parent's full conversation context to do the work.

## Two modes: `spawn` vs `fork`

The child pi process can be started two ways, and the choice materially changes behavior.

- **`spawn`** (default) — Child receives only the task string. Fresh context, no history. Lower cost, no context leakage. Best for isolated, reproducible work.
- **`fork`** — Child receives a snapshot of the parent's context plus the task. Higher cost, but the child knows what you've been working on. Best when the task depends on prior discussion or recent file reads.

Default to `spawn`. Reach for `fork` only when the task genuinely depends on parent context.

## Minimal sub-agent extension

The cleanest implementation shells out to `pi` as a subprocess. This sidesteps the complexity of embedding pi-in-pi and gives you natural isolation.

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Sub-agent",
    description:
      "Delegate a self-contained task to a fresh pi child session with its own context. Use for codebase recon, audits, or any task that would flood the current context. The child cannot ask follow-up questions — give it everything it needs in the prompt.",
    parameters: Type.Object({
      task: Type.String({ description: "Full task description for the child" }),
      mode: Type.Optional(Type.String({
        enum: ["spawn", "fork"],
        description: "spawn: fresh context. fork: inherit parent context.",
      })),
      model: Type.Optional(Type.String({
        description: "Model override (e.g., 'claude-haiku-4-5' for cheap recon)",
      })),
    }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      const args = ["-p", params.task, "--no-extensions"];
      if (params.model) args.push("--model", params.model);

      return new Promise((resolve) => {
        const child = spawn("pi", args, { signal });
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (d) => {
          stdout += d.toString();
          onUpdate({ status: `Sub-agent: ${stdout.slice(-60)}` });
        });
        child.stderr.on("data", (d) => { stderr += d.toString(); });

        child.on("close", (code) => {
          if (code !== 0) {
            resolve({
              content: [{ type: "text", text: `Sub-agent failed (exit ${code}):\n${stderr.slice(-2000)}` }],
              isError: true,
            });
            return;
          }
          resolve({
            content: [{ type: "text", text: stdout.trim().slice(0, 20_000) }],
            details: { exitCode: code },
          });
        });
      });
    },
  });
}
```

Notes on this pattern:

- `--no-extensions` (`-ne`) runs the child without any extensions. Crucial — otherwise the child could recursively spawn more sub-agents. Existing sub-agent extensions hardcode this.
- The `signal` from `execute` is handed to `spawn`, so user cancellation kills the child.
- Output is truncated; child can be verbose and parent's budget is tight.

## Depth limits — avoid recursion bombs

Without limits, a sub-agent can spawn a sub-agent can spawn a sub-agent. Existing pi sub-agent extensions use:

- `--subagent-max-depth 3` (default) — maximum nesting.
- `--subagent-max-depth 0` — disables delegation entirely.
- `--no-subagent-prevent-cycles` — opt out of cycle detection (not recommended).

If you're rolling your own, pass a depth counter via env var (`PI_SUBAGENT_DEPTH`) and refuse to spawn when over the limit.

## Defining specialized agents (agent definitions)

The productive pattern isn't one generic `subagent` tool — it's multiple named agents, each with:

1. A specific system prompt (so the child has the right priors).
2. A whitelisted set of tools (so it can't do things outside its scope).
3. A fixed model (Haiku for recon, Sonnet for implementation).

Existing extensions (e.g. `nicobailon/pi-subagents`) read agent definitions from markdown files:

```markdown
---
name: scout
description: Fast codebase reconnaissance — finds files, reads structure, summarizes
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
---

You are a reconnaissance agent. Your job is to find relevant files and
summarize them concisely. Do not write or edit anything. Return a bullet
list of findings with file paths and one-line summaries.
```

Placed in `~/.pi/agent/agents/scout.md`. The extension loads all `*.md` files from this directory on `session_start` and registers each as a tool named `run_<agent>` or similar. The LLM then picks the right specialist.

## The scout → planner → worker pipeline

The classic multi-agent pattern:

1. **Scout** (Haiku, read-only tools) — find the relevant code.
2. **Planner** (Sonnet, read-only tools) — propose the approach.
3. **Worker** (Sonnet, full tools) — implement it.

The parent orchestrates by calling each in sequence. Scout's output feeds planner's prompt, planner's output feeds worker's prompt. Each runs in an isolated context — the parent doesn't accumulate the recon details, the planner's reasoning, or the worker's intermediate state.

For truly independent tasks, run sub-agents in parallel. Have the tool take an `array` of tasks and kick them off concurrently:

```ts
const results = await Promise.all(tasks.map(runChild));
```

Only parallelize tasks that are **genuinely independent** — no shared files being modified, no ordering constraint on the output.

## Output handling

Sub-agent outputs can be large. Strategies:

- **Truncate aggressively** in the tool result. The LLM doesn't need every word.
- **Write the full output to disk** and return the path plus a summary. The LLM can `read` it if it needs detail.
- **Stream progress** via `onUpdate` so the user sees activity.

## Top failure modes

1. **Sub-agent spawns sub-agents.** Always run children with `--no-extensions` or an explicit whitelist that excludes the sub-agent extension.
2. **Child hangs forever.** Set a timeout (`setTimeout` + `child.kill()`). Pi's `signal` covers user cancel but not runaway child.
3. **Enormous output floods parent context.** Always truncate. Consider writing to a tempfile and returning the path.
4. **Forgetting the task doesn't get follow-ups.** The child can't ask clarifying questions back to the user. If your prompt is ambiguous, the child will guess. Front-load context.
5. **Model mismatch.** If the registered model name doesn't match what pi's provider registry knows, the child fails fast. Verify with `pi list-models` before baking in specific IDs.
