# Sub-agents

A sub-agent in Pi is **a second `AgentSession` instance spun up from within a tool**, given an isolated context window, a task prompt, and a (usually narrower) tool set. The parent agent calls the sub-agent tool, the sub-agent runs its own loop, and the parent only sees the sub-agent's final summary.

This is how Pi implements features other agents call "subagents", "delegation", or "plan mode". There's no magic: it's a tool whose `execute` creates a new session.

## When to use sub-agents

- **Context isolation** — the parent shouldn't be polluted with the sub-agent's intermediate steps. Good for research, code search, "look through all these files and tell me X".
- **Role specialisation** — a sub-agent with a different system prompt, tool set, or model (e.g. a planner with no write access, or a summariser with a cheap model).
- **Parallel work** — spawn several sub-agents from one tool call (or from sibling tool calls) and merge results.

Don't use a sub-agent when a single tool call would suffice. Sub-agents cost tokens (new system prompt, new tool descriptions) and add latency.

## The basic pattern

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "agent",
    label: "Agent",
    description:
      "Delegate a task to a specialised agent with isolated context. " +
      "Use when the task is self-contained and you only need the final result, " +
      "not the intermediate steps.",
    parameters: Type.Object({
      task: Type.String({
        description: "The full task description. The sub-agent only sees this.",
      }),
      tools: Type.Optional(Type.Array(Type.String(), {
        description: "Restrict the sub-agent to these tool names. Default: read-only.",
      })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "Starting sub-agent…" }],
        details: {},
      });

      // Build a resource loader that sees the same extensions/skills as the parent
      const loader = new DefaultResourceLoader();
      await loader.reload();

      const { session } = await createAgentSession({
        resourceLoader: loader,
        systemPrompt:
          "You are a focused task agent. Finish the given task, report the result " +
          "in <result>...</result> tags, then stop.",
        activeTools: params.tools ?? ["read", "grep", "find", "ls"],
        // Share the parent's model
        model: ctx.model,
      });

      // Run the task
      const result = await session.run({
        prompt: params.task,
        signal,
      });

      // Extract the final assistant message as the return value for the parent
      const summary = extractResult(result);

      return {
        content: [{ type: "text", text: summary }],
        details: {
          subAgentMessages: result.messages.length,
          toolCalls: result.toolCalls?.length ?? 0,
        },
      };
    },
  });
}

function extractResult(result: { messages: Array<{ role: string; content: unknown }> }): string {
  // Walk messages from the end; find the final assistant text
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const m = result.messages[i];
    if (m.role === "assistant") {
      // pull out text content (schema depends on pi-ai version)
      return String(m.content);
    }
  }
  return "(no result)";
}
```

> Note: `createAgentSession` and `AgentSession.run` signatures can evolve. The up-to-date reference is `packages/coding-agent/docs/sdk.md` in pi-mono. When building a real sub-agent, `view` that file first.

## Restricting the sub-agent's tool set

Three common policies:

1. **Read-only sub-agent** — `["read", "grep", "find", "ls"]`. Useful for research.
2. **Sandboxed write** — use `createBashTool` with a `spawnHook` that redirects into a tempdir, plus `edit`/`write` on that tempdir only.
3. **Domain-specific** — only the extension's own tools (e.g. a `deploy` sub-agent that has `get_status`, `deploy`, `rollback`).

Control the set via `activeTools` on `createAgentSession`, or by passing `customTools` if you want completely custom tools the parent doesn't have.

## System prompts

The sub-agent's system prompt determines its behaviour. Keep it small, focused, and terminal — tell the sub-agent to stop as soon as it has the answer.

A reliable pattern:

```
You are a task agent. You have been given a specific sub-task by a parent agent.

Your job:
1. Complete the task using the tools available.
2. When done, respond with the final answer wrapped in <result>...</result> tags.
3. Stop. Do not ask questions. Do not offer follow-ups.

Tools available: <list>
Budget: 10 tool calls max. If you cannot complete the task, respond with <result>FAILED: reason</result>.

Task:
```

Then the `task` parameter is appended. The budget and stop instructions matter — without them sub-agents loop.

## Plan mode — a longer example

Plan mode is a well-known sub-agent pattern: the user enters "plan mode", the agent produces a plan without executing, and only after approval does execution begin. Implementation shape:

```ts
pi.registerCommand("plan", {
  description: "Enter plan mode — propose a plan without executing.",
  handler: async (args, ctx) => {
    // 1. Toggle a flag
    inPlanMode = true;
    ctx.ui.setStatus("plan", "plan mode");
    pi.setActiveTools(["read", "grep", "find", "ls"]); // no mutations
    // 2. Inject a system-prompt modifier
    //    (done via before_agent_start handler that checks inPlanMode)
    // 3. Send the user's request
    pi.sendUserMessage(args);
  },
});

pi.on("before_agent_start", async (event) => {
  if (inPlanMode) {
    return {
      systemPrompt: event.systemPrompt +
        "\n\nYou are in PLAN MODE. Propose a detailed plan in <plan>...</plan> tags. " +
        "Do NOT execute any mutating operations. Wait for user approval before acting.",
    };
  }
});

pi.registerCommand("approve", {
  description: "Approve the current plan and execute it.",
  handler: async (_args, ctx) => {
    inPlanMode = false;
    ctx.ui.setStatus("plan", undefined);
    pi.setActiveTools(pi.getAllTools().map(t => t.name)); // restore all
    pi.sendUserMessage("Approved. Proceed with the plan above.");
  },
});
```

The full `plan-mode/` example in `pi-mono`'s `examples/extensions/` has the production version with plan persistence and UI widgets.

## Multi-agent orchestration

Two patterns:

### Fan-out / fan-in

The parent tool spawns N sub-agents in parallel (`Promise.all`), each with a different task, and merges results. Useful for "review these 5 files" or "compare these approaches".

```ts
async execute(_id, params, signal) {
  const tasks = params.tasks as string[];
  const results = await Promise.all(
    tasks.map((task) => runSubAgent(task, signal))
  );
  return {
    content: [{ type: "text", text: results.join("\n\n---\n\n") }],
    details: { count: results.length },
  };
}
```

Watch the total cost — each sub-agent has its own context.

### Pipelined agents

Agent A produces output → Agent B refines → Agent C finalises. Each is a separate tool call, potentially across separate turns. Use `pi.sendUserMessage("Stage 2: ...", { deliverAs: "followUp" })` to chain automatically after the current turn finishes.

## Communication between parent and sub-agent

The sub-agent returns one thing: the final message string. To pass back structured data:

- **Tagged output** — sub-agent writes `<result>{"foo":"bar"}</result>`, parent parses. Simple, model-friendly.
- **Side-channel file** — sub-agent writes to a tempfile, parent reads. Good for large outputs.
- **Tool `details`** — parent's sub-agent tool can include structured info in `details`, separate from the text in `content`.

Avoid shared mutable state. If parent and sub-agent operate on the same files, both should use `withFileMutationQueue`.

## Cost and latency considerations

- A sub-agent adds: one full system prompt, tool descriptions for its active set, and N turns of its own.
- Rule of thumb: delegate if the sub-task would take >5 tool calls in the parent's context. Otherwise, do it inline.
- Use a cheaper model for research/summarisation sub-agents. Override per-sub-agent via `createAgentSession({ model: ... })`.

## The SDK entry point

The full SDK lives at `packages/coding-agent/docs/sdk.md`. Relevant exports:

- `createAgentSession(options)` — creates a new session.
- `DefaultResourceLoader` — discovers extensions, skills, prompts, themes from the standard paths.
- `AgentSessionRuntime` — the lower-level runtime if you need to manage multiple sessions explicitly.

`createAgentSession` options (abbreviated — always verify against the current docs):

- `resourceLoader` — where extensions and skills come from
- `systemPrompt` — override the default
- `activeTools` — subset of tool names
- `customTools` — tools not in the parent's list
- `model` — which model to use
- `messages` — seed conversation (useful for resuming)

## Checklist for a sub-agent tool

- [ ] System prompt tells the sub-agent to produce a terminal `<result>` and stop
- [ ] Active tool set is as narrow as possible
- [ ] Budget (max tool calls) is enforced somehow — instructions, or a loop guard in `execute`
- [ ] `signal` is threaded into the sub-agent's `run()`
- [ ] Tool `content` is the *summary*, not the whole sub-agent transcript
- [ ] Tool `details` include metadata for debugging (turn count, tool calls, cost if available)
- [ ] Model choice documented — parent's model or a cheaper one?
- [ ] Failure modes documented — what does the sub-agent return on timeout, abort, unreachable tool?
