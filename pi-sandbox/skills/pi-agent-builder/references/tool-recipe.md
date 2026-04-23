# Tool recipe: `pi.registerTool`

Tools are what the LLM calls mid-conversation. Their output lands in the context window, so design them with the LLM as the consumer — not a human.

## Minimal working example

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "greet",
    label: "Greeting",
    description: "Generate a friendly greeting for a named person. Use when the user asks Pi to say hello to someone by name.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the person to greet" }),
    }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });
}
```

## The fields, in order of importance

### `description` — this is a prompt for the LLM

The description decides whether the LLM picks your tool. Include:

1. **What it does** — one sentence.
2. **When to use it** — concrete triggers. Mention tasks and user phrases.
3. **What to avoid** — if there's a related built-in or another tool, say when *not* to use yours.
4. **Input constraints** — ranges, formats, mutual exclusivity.

A weak description (`"Deploys the app"`) underperforms. A strong one reads like onboarding a junior engineer.

### `parameters` — use TypeBox

Pi uses the `typebox` package for schemas (migrated from `@sinclair/typebox` in pi 0.69.0 — legacy path still aliased, but new extensions should import from `typebox`). The schema is converted to JSON Schema for the LLM.

```ts
import { Type } from "typebox";

parameters: Type.Object({
  environment: Type.String({
    description: "Deploy target",
    enum: ["staging", "production"],
  }),
  force: Type.Optional(Type.Boolean({ description: "Skip pre-deploy checks" })),
  tags: Type.Array(Type.String(), { description: "Git tags to include" }),
})
```

**Gotcha**: for string enums that need to work with Google/Gemini providers, use the `StringEnum` helper from pi (not `Type.String({ enum: [...] })`) — Google's API is strict about this. `StringEnum` is a **named export** from `@mariozechner/pi-ai`, *not* a method on `Type`. `Type.StringEnum(...)` throws at runtime — import and call it directly:

```ts
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

parameters: Type.Object({
  verdict: StringEnum(["approve", "revise"] as const, {
    description: "approve = file is good as-is; revise = send back with feedback",
  }),
}),
```

### `name` and `label`

- `name` — snake_case identifier the LLM sees and calls. Avoid collisions with built-ins (`bash`, `read`, `write`, `edit`, `grep`, `glob`, `ls`, `task`).
- `label` — human-readable name shown in the TUI.

### `execute` — the actual work

```ts
async execute(toolCallId, params, signal, onUpdate, ctx) {
  // 1. Validate beyond what the schema catches
  if (params.tags.length === 0) {
    return {
      content: [{ type: "text", text: "Error: at least one tag is required." }],
      details: { error: "no_tags" },
    };
  }

  // 2. Stream progress for long operations
  onUpdate({ status: "Fetching tags..." });

  // 3. Respect cancellation
  const response = await fetch(url, { signal });

  // 4. Return structured content
  return {
    content: [{ type: "text", text: summarize(response) }],
    details: { deploymentId: response.id },
  };
}
```

**Parameters of `execute`** (order matters — pi passes them positionally):

- `toolCallId` — unique per call; use for correlation in logs.
- `params` — validated against your schema.
- `signal` — `AbortSignal`; if the user cancels, this fires. **Always pass it to `fetch` and subprocess calls.**
- `onUpdate` — progress reporter; call it with `{ status, ... }` to update the TUI.
- `ctx` — the runtime context (see below).

**Return shape:**

```ts
{
  content: Array<{ type: "text"; text: string } | { type: "image"; ... }>,
  details: Record<string, unknown>,    // REQUIRED — not optional. Pass {} if nothing to say.
  isError?: boolean,                   // surfaces as error in UI
  terminate?: boolean,                 // hint to stop after this tool batch (see below)
}
```

The LLM sees `content`. `details` is for your own bookkeeping and for custom renderers — but it is **required** by `AgentToolResult<unknown>`, so a stub tool that has nothing structured to report must still `return { content: [...], details: {} }`. Omitting `details` fails TS compile.

### Early termination — `terminate: true`

Added in pi 0.69.0. Return `terminate: true` from `execute()` to hint
that pi should skip the automatic follow-up LLM turn after the current
tool batch. Use it when the tool call itself **is** the final answer —
the agent doesn't need to say anything else — and you'd rather not pay
for another model call just to get "Done." out of the LLM.

Caveat: `terminate` only takes effect when **every** finalized tool
result in the batch is terminating. Parallel tool calls where any
non-terminating tool fires will still produce a follow-up turn.

Canonical use cases:

- **Structured-output tools** — the tool emits the final JSON / report;
  there's nothing for the agent to add.
- **Stop / exit markers** — a `/done` or `/submit` equivalent.
- **Stub tools whose result already contains everything** — e.g. a
  `search_answer` that returns a full-formed answer.

Minimal example:

```ts
pi.registerTool({
  name: "submit_answer",
  label: "Submit Answer",
  description:
    "Return the final answer. Use this as your LAST action when you have " +
    "everything the user asked for.",
  promptGuidelines: [
    "Use submit_answer as your final action. Do not emit another assistant message after calling it.",
  ],
  parameters: Type.Object({
    answer: Type.String(),
  }),
  async execute(_id, params) {
    return {
      content: [{ type: "text", text: `Submitted: ${params.answer}` }],
      details: { answer: params.answer },
      terminate: true,
    };
  },
});
```

The paired `promptGuidelines` entry matters — the LLM needs a prompt
hook telling it *when* to use the tool as its last action. Without the
guideline, the model may keep the tool in rotation and call other
things after it, which nullifies the batch-terminate condition.

See `node_modules/@mariozechner/pi-coding-agent/examples/extensions/structured-output.ts`
for pi's own minimal demo.

**Do NOT use `terminate` when:**

- The agent might legitimately want to keep working after this tool
  (e.g. a writer tool that may be called multiple times in a loop —
  setting `terminate` would stop after the first call).
- Other tools in the same batch might not be terminating — the hint
  won't take effect.

## The `ctx` object — what you actually have

Inside `execute`, `ctx` gives you:

- `ctx.ui.notify(message, level)` — `"info" | "warning" | "error"` (not `"warn"`, not `"success"`)
- `ctx.ui.confirm(title, message)` — returns `Promise<boolean>`
- `ctx.ui.select(title, options)` — single-choice picker
- `ctx.ui.input(title, prompt)` — text input
- `ctx.ui.custom(component)` — full TUI component with keyboard input
- `ctx.shutdown()` — request pi to exit (emits `session_shutdown` first)
- `ctx.getContextUsage()` — `{ tokens, ... } | undefined` for the active model
- `ctx.compact({ customInstructions, onComplete, onError })` — trigger compaction
- `ctx.getSystemPrompt()` — current effective system prompt (includes modifications)
- `ctx.reload()` — reload extensions/skills/prompts/themes

## Output budget — critical

Tool results feed back into context. Pi's built-in budget is **50KB or 2000 lines, whichever comes first**. Beyond that you risk context overflow, compaction failures, and degraded model behavior.

Practical rules:

- If you have a giant output, summarize it or write it to disk and return the path.
- For tabular data, truncate rows and include a count: `"Showing 50 of 4,318 rows."`
- For logs, return the tail plus a path to the full file.
- Never return binary data as text.

## Top three failure modes

1. **Description is too vague.** LLM doesn't call the tool when it should, or calls it when it shouldn't. Fix: add concrete triggers and anti-triggers.
2. **Schema drift.** You change `parameters` without restarting pi. The LLM sends old-shaped args; execute throws. Fix: `/reload` after any schema change.
3. **Unhandled rejection on network error.** Tool throws, pi shows a stack. Fix: wrap the body in try/catch, return `{ content: [...], isError: true }` with a readable message.

## When to use streaming updates

Call `onUpdate({ status: "..." })` for any operation over ~1 second. The user sees it in the TUI and knows pi hasn't hung. For really long operations (deploys, builds), emit phase updates: `"Building..."`, `"Uploading..."`, `"Waiting for health check..."`.
