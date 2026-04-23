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

**Rule of thumb**: delegate if the sub-task would take more than ~5 tool calls in the parent's context; otherwise do it inline. Sub-agents cost a full system prompt, a full tool-description block, and N turns of their own — the overhead only pays off when the parent-context savings are substantial.

## Two modes: `spawn` vs `fork`

The child pi process can be started two ways, and the choice materially changes behavior.

- **`spawn`** (default) — Child receives only the task string. Fresh context, no history. Lower cost, no context leakage. Best for isolated, reproducible work.
- **`fork`** — Child receives a snapshot of the parent's context plus the task. Higher cost, but the child knows what you've been working on. Best when the task depends on prior discussion or recent file reads.

Default to `spawn`. Reach for `fork` only when the task genuinely depends on parent context.

## Subprocess vs in-process

The patterns below all shell out to a child `pi` **subprocess**. This is the default choice in this repo — it's what the canonical `.pi/extensions/deferred-writer.ts` and `.pi/extensions/delegated-writer.ts` do. Subprocess isolation gives you a clean process boundary: separate context, separate tool surface via `--tools`, separate PID for SIGKILL timeouts, and the NDJSON event stream lets the parent observe every tool call the child makes.

Pi also exposes an **in-process** API — `createAgentSession` from `@mariozechner/pi-coding-agent`, which spins up a second `AgentSession` inside the same Node process. It's lower-overhead (no fork, no spawn, no JSON serialization) and lets you pass `customTools` the parent doesn't have. Trade-offs: no process-level kill lever, no `--tools` allowlist flag (you pass `activeTools: [...]` instead), and no native NDJSON stream to harvest from — you work with the returned `messages` array.

Prefer subprocess in this repo unless you have a specific reason to stay in-process (performance-critical paths, sharing live JS state with the parent). The up-to-date in-process SDK reference is `packages/coding-agent/docs/sdk.md` in pi-mono — grep for `createAgentSession`, `DefaultResourceLoader`, and `AgentSessionRuntime` when you need the current signatures.

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

## Pipelined agents across turns

For a pipeline that needs to cross a turn boundary — "Stage 1 produces output, Stage 2 refines it" — don't run both inside one tool call. Use `pi.sendUserMessage("Stage 2: …", { deliverAs: "followUp" })` at the end of Stage 1 so pi queues Stage 2 as a follow-up user turn. This keeps each stage's tool result visible in the parent transcript (vs. one giant tool result that hides the intermediate work) and lets the parent LLM condition on Stage 1's output before Stage 2 runs.

Use the fan-out/fan-in parallel pattern (Promise.all over `spawn` calls) when stages are independent and can race. Use `deliverAs: "followUp"` only when Stage 2 genuinely needs Stage 1's output in the parent's visible transcript.

## Output handling

Sub-agent outputs can be large. Strategies:

- **Truncate aggressively** in the tool result. The LLM doesn't need every word.
- **Write the full output to disk** and return the path plus a summary. The LLM can `read` it if it needs detail.
- **Stream progress** via `onUpdate` so the user sees activity.

## Orchestrator-over-extension (stub-tool harvest, one level up)

The stub-tool pattern (`stage_write` harvesting path+content from the
drafter's event stream) generalizes one level higher: a **delegator**
LLM whose only tool is a stub that the parent harvests and dispatches
to the real pipeline. Use this when the *decision of what subtasks to
run* is itself an LLM judgment — the parent doesn't know in advance
whether to call the drafter 1 or 5 times.

Shape:

- Parent registers a slash command. Handler spawns **one** child pi
  (RPC mode — see `defaults.md` → *Persistent RPC sub-agents*) as
  the delegator.
- Child is loaded with stub tools via `-e <abs path>` and
  `--tools run_deferred_writer,review --no-extensions`. Neither tool
  has a real implementation; their `execute` bodies are no-ops that
  return `{ content: [...], details: {} }`.
- Parent reads the child's stdout NDJSON. Every
  `tool_execution_start` for `run_deferred_writer` carries
  `e.args.task` — the parent dispatches a *real* drafter child
  (the single-task `deferred-writer` pattern, or a direct spawn of
  its guts) for that task, in parallel with any other dispatches
  from the same turn.
- After drafters finish, parent prompts the delegator again: "here
  are the drafts; call `review` for each." Each `review` call's
  `{file_path, verdict, feedback?}` is harvested the same way; on
  `revise` the parent re-dispatches the drafter for that task with
  the feedback appended, up to a bounded iteration count.
- Final promotion: parent `fs.writeFileSync`s the approved drafts
  into `process.cwd()`. No human confirm — the reviewer LLM is the
  approval gate.

Key properties this pattern preserves:

- **Narrow tool surface at every layer.** Delegator has two stubs,
  nothing else. Each drafter has only `stage_write,ls,read`. Nothing
  anywhere can `bash` or `write` directly.
- **Nothing touches disk until approval.** Drafts live in parent
  memory (path + content harvested from NDJSON) until the reviewer
  approves; revisions replace the in-memory entry without ever
  writing a rejected draft.
- **One cost meter, one session.** RPC keeps the delegator's
  conversation continuous; cost accumulates from each `message_end`
  across all phases.

Reference: `.pi/extensions/delegated-writer.ts` (orchestrator) +
`.pi/child-tools/run-deferred-writer.ts` (dispatch stub).

## Reviewer with revise-loop

The second stub in the orchestrator pattern is a reviewer. Shape:

```ts
pi.registerTool({
  name: "review",
  label: "Review",
  description: "Decide whether a drafted file is good as-is or needs revision. …",
  parameters: Type.Object({
    file_path: Type.String({ description: "Relative path of the drafted file being reviewed." }),
    verdict: StringEnum(["approve", "revise"] as const, {
      description: "approve = promote this draft; revise = send it back to the drafter with feedback",
    }),
    feedback: Type.Optional(Type.String({
      description: "REQUIRED when verdict='revise'. Concrete, actionable feedback for the drafter.",
    })),
  }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: `Reviewed ${params.file_path}: ${params.verdict}` }], details: {} };
  },
});
```

Loop in the parent:

1. Dispatch drafter with the task, harvest `{path, content}`.
2. Feed `(path, content)` back to the delegator: "Call `review` for
   this file."
3. On `approve`: mark the draft promotable.
4. On `revise`: re-dispatch the drafter with the original task +
   `"Revision feedback: \${feedback}"` appended. Cap at 3 iterations
   per subtask — past that, bail out with a `notify` and *still
   surface the accumulated cost* (see `defaults.md` → *Cost
   tracking*).
5. No `ctx.ui.confirm` anywhere on the success path — the reviewer
   LLM is the gate.

Reference: `.pi/child-tools/review.ts` (correctly imports
`StringEnum` from `@mariozechner/pi-ai` and returns `details: {}`).

## Top failure modes

1. **Sub-agent spawns sub-agents.** Always run children with `--no-extensions` or an explicit whitelist that excludes the sub-agent extension.
2. **Child hangs forever.** Set a timeout (`setTimeout` + `child.kill()`). Pi's `signal` covers user cancel but not runaway child.
3. **Enormous output floods parent context.** Always truncate. Consider writing to a tempfile and returning the path.
4. **Forgetting the task doesn't get follow-ups.** The child can't ask clarifying questions back to the user. If your prompt is ambiguous, the child will guess. Front-load context.
5. **Model mismatch.** If the registered model name doesn't match what pi's provider registry knows, the child fails fast. Verify with `pi list-models` before baking in specific IDs.
