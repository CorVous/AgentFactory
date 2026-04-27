# Events recipe: `pi.on`

Events are how extensions observe, intercept, and modify pi's behavior. This is the single most powerful mechanism in the extension API — approval gates, sandboxing, context injection, and custom compaction all happen through events.

## The event pattern

```ts
pi.on("tool_call", async (event, ctx) => {
  // Inspect event.toolName, event.input
  // Return nothing → allow
  // Return { block: true, reason: "..." } → cancel the tool call
  // Return { input: modifiedInput } → rewrite the args
});
```

Return values matter. An event handler that returns `undefined` is purely observational. A handler that returns a specific shape **modifies or cancels** the operation.

## The important events

Event names stabilize around these categories. Verify against `examples/extensions/types.ts` in the installed package for the authoritative list — the set evolves.

### Tool lifecycle

- `tool_call` — fires **before** the tool runs. Can block or modify input. The most-used event.
- `tool_result` — fires **after** the tool runs. Observational; good for logging and metrics.

### Session lifecycle

- `session_start` — session is ready. `event.reason` can be `"new" | "resume" | "fork"`. Use for one-time setup per session.
- `session_before_switch` — before pi switches to a different session. Cancellable.
- `session_switch` — after switching.
- `session_before_compact` — **cancellable**. Can provide a custom summary, redirect to a different model, or skip compaction entirely.
- `session_compact` — after compaction completes.
- `session_shutdown` — cleanup hook. Close connections, kill subprocesses, flush buffers. Fires on exit **and** before a fork.

### Context and agent turn

- `context` — fires **before every LLM call**, giving you the message array. Modifying `event.messages` rewrites what the model sees. Use for pruning, injection, RAG.
- `before_agent_start` — can modify the system prompt for the current turn.
- `agent_step` — per step of the agent loop; observational.

### Provider and resources

- `resources_discover` — discover models and providers.
- The async factory runs **before** `session_start`, `resources_discover`, and before queued provider registrations flush.

## Pattern 1: approval gate

The canonical example. Block destructive commands unless confirmed.

```ts
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return;
  const cmd = event.input.command ?? "";
  if (!/\brm\s+-rf\b|\bdd\s+.*of=/.test(cmd)) return;

  const ok = await ctx.ui.confirm("Dangerous command", `Allow: ${cmd}?`);
  if (!ok) return { block: true, reason: "User declined dangerous command" };
});
```

When `block: true` is returned, the LLM sees a tool result with the reason — it can decide to try something else.

## Pattern 2: context injection (RAG, memory)

Inject retrieved context before every LLM call.

```ts
pi.on("context", async (event, ctx) => {
  const lastUser = [...event.messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return;
  const query = extractText(lastUser);
  const docs = await retrieveRelevant(query);
  if (docs.length === 0) return;

  // Prepend a system-role message with the retrieved context
  event.messages.unshift({
    role: "system",
    content: [{ type: "text", text: formatDocs(docs) }],
  });
});
```

Mutating `event.messages` directly works. Keep injected content small — you're spending tokens on every turn.

## Pattern 3: context pruning

Trim old tool results to keep the window focused.

```ts
pi.on("context", (event, ctx) => {
  const threshold = 10; // keep last 10 messages untouched
  event.messages = event.messages.map((msg, i) => {
    const isOld = i < event.messages.length - threshold;
    if (!isOld) return msg;
    if (msg.role !== "toolResult") return msg;
    const text = msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    if (text.length < 2000) return msg;
    return {
      ...msg,
      content: [{ type: "text", text: text.slice(0, 500) + "\n...[truncated]..." }],
    };
  });
});
```

## Pattern 4: tool redirection

Rewrite tool inputs on the fly — useful for routing `bash` through SSH on a remote VM, for example.

```ts
let activeVmId: string | null = null;

pi.on("tool_call", (event, ctx) => {
  if (event.toolName !== "bash" || !activeVmId) return;
  return {
    input: {
      ...event.input,
      command: `ssh -p 443 ${activeVmId} '${event.input.command}'`,
    },
  };
});
```

This pattern — exposed by the Vers extension — lets the LLM keep calling `bash` while your extension transparently redirects execution to a VM, container, or remote host.

## Pattern 5: custom compaction

See `references/compaction-recipe.md` for the full treatment. The hook is `session_before_compact` returning `{ summary: "..." }` or `{ cancel: true }`.

## Return-value rules

| Event | Return to allow | Return to block | Return to modify |
|---|---|---|---|
| `tool_call` | `undefined` | `{ block: true, reason }` | `{ input: {...} }` |
| `session_before_compact` | `undefined` | `{ cancel: true }` | `{ summary: "..." }` |
| `session_before_switch` | `undefined` | `{ cancel: true, reason }` | — |
| `context` | `undefined` (mutations persist) | — | mutate `event.messages` |
| All others | observational | — | — |

## Handler ordering

Multiple extensions can listen to the same event. Pi runs them in registration order. A handler that blocks short-circuits later handlers. Design handlers to be **idempotent and order-independent** where possible.

## Top failure modes

1. **Swallowing errors inside handlers.** A throw inside `tool_call` propagates and can halt the tool. Wrap in try/catch and log via `ctx.ui.notify` when appropriate.
2. **Leaking resources on `/reload`.** Hot-reload replaces the extension instance. Subscribe cleanup in `session_shutdown`.
3. **Infinite loops via `sendUserMessage` inside an event handler.** If you queue a message from `tool_call`, ensure it doesn't cause another matching `tool_call`.
4. **Mutating `event.messages` in a way the serializer rejects.** Keep the shape — role, content array of typed blocks. Don't invent new roles.
