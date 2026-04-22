# Events

Pi emits events across the session lifecycle. Subscribe with `pi.on(name, handler)`. This doc covers the events you'll use most and the contracts on their return values.

## The lifecycle

```
pi starts
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }

user submits prompt
  ├─► (extension commands checked first — if /name matches, handler runs and input is skipped)
  ├─► input
  ├─► (skill/template expansion if not handled)
  ├─► before_agent_start
  ├─► agent_start
  │
  │   repeats while LLM calls tools:
  │   ├─► turn_start
  │   ├─► context
  │   ├─► before_provider_request
  │   │
  │   │   LLM responds, may call tools:
  │   │   ├─► tool_execution_start
  │   │   ├─► tool_call            ← can block / mutate input
  │   │   ├─► tool_execution_update
  │   │   ├─► tool_result          ← can patch result
  │   │   └─► tool_execution_end
  │   │
  │   └─► turn_end
  │
  └─► agent_end

/new, /resume, /fork
  ├─► session_before_switch / session_before_fork (can cancel)
  ├─► session_shutdown (old instance)
  ├─► session_start { reason: "new" | "resume" | "fork" }
  └─► resources_discover

/compact or auto-compaction
  ├─► session_before_compact (can cancel or customise)
  └─► session_compact

exit (Ctrl+C, Ctrl+D)
  └─► session_shutdown
```

## Handler shape

```ts
pi.on("event_name", async (event, ctx) => {
  // event  — event-specific payload (typed)
  // ctx    — ExtensionContext (see api-overview.md)
  // return — optional; shape depends on event (some block, some patch)
});
```

Handlers can be async. They run in extension load order for events that chain (`tool_call`, `tool_result`, `context`, `before_provider_request`, `input`).

## Key events

### `session_start`

Fires once at startup and again on `/new`, `/resume`, `/fork`, `/reload`.

```ts
pi.on("session_start", async (event, ctx) => {
  // event.reason:            "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile — for "new", "resume", "fork"

  // Rehydrate in-memory state from session entries
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      if (entry.message.toolName === "my_tool") {
        myState = entry.message.details?.state ?? {};
      }
    }
  }
});
```

**Always run state rehydration here.** Closures don't survive `/reload` or session switch.

### `session_shutdown`

Fires on exit or before a session switch. Good for cleanup, flushing writes, closing connections.

```ts
pi.on("session_shutdown", async () => {
  await connection?.close();
});
```

### `before_agent_start`

Fires after the user submits a prompt, before the agent loop runs. Two useful return values:

```ts
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt         — user's text
  // event.images         — attached images
  // event.systemPrompt   — current system prompt

  return {
    // Inject a visible-to-LLM message into the session
    message: {
      customType: "my-ext",
      content: "Pre-flight context from extension...",
      display: true,
    },
    // Modify system prompt for this turn only (chains across extensions)
    systemPrompt: event.systemPrompt + "\n\nExtra instructions for this turn.",
  };
});
```

Returning nothing is fine. Returning partial (only `message` or only `systemPrompt`) is fine.

### `tool_call` — gating and mutation

Fires right before a tool executes. **Can block. Can mutate input.**

```ts
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    // event.input is typed as { command: string; timeout?: number }
    // Mutate in place:
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (/rm\s+-rf\s+\//.test(event.input.command)) {
      return { block: true, reason: "Refused: matched rm -rf /" };
    }

    if (event.input.command.includes("sudo")) {
      const ok = await ctx.ui.confirm("sudo detected", "Allow this command?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  }
});
```

Rules:

- **Return only `{ block: true, reason?: string }` or nothing.** Any other return shape is ignored.
- **Mutate `event.input` in place.** Returning a new input object does nothing.
- Input is **not re-validated** after mutation. Keep the shape correct.
- Later `tool_call` handlers see earlier mutations.

For custom tools, use `isToolCallEventType` with explicit type params so TypeScript typechecks:

```ts
import type { MyToolInput } from "./tools.js";
if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
  event.input.action; // typed
}
```

### `tool_result` — post-processing

Fires after a tool finishes, before the result becomes a message. **Can patch the result.** Handlers chain like middleware.

```ts
import { isBashToolResult } from "@mariozechner/pi-coding-agent";

pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError

  if (isBashToolResult(event)) {
    // event.details is typed as BashToolDetails
  }

  // Partial patch: omitted fields keep their current values
  return {
    content: event.content,
    details: { ...event.details, audited: true },
  };
});
```

Use `ctx.signal` for abortable async work inside the handler (`fetch`, model calls).

### `context` — modify messages before LLM call

Fires before every LLM call. `event.messages` is a deep copy — safe to mutate. Return `{ messages: filtered }` to replace.

```ts
pi.on("context", async (event, ctx) => {
  // Drop verbose tool results older than 5 turns
  const filtered = event.messages.map((m, i) => {
    if (i < event.messages.length - 10 && m.role === "toolResult") {
      return { ...m, content: [{ type: "text", text: "[elided]" }] };
    }
    return m;
  });
  return { messages: filtered };
});
```

This is the RAG / context-shaping hook. Don't do heavy work here — it runs on every turn.

### `before_provider_request` — inspect or replace payload

Fires right before the HTTP request to the provider. Handlers run in load order. Return `undefined` to leave unchanged, return a new payload to replace.

```ts
pi.on("before_provider_request", (event) => {
  if (process.env.DEBUG_PROVIDER) {
    console.log(JSON.stringify(event.payload, null, 2));
  }
  return { ...event.payload, temperature: 0 };
});
```

Mainly useful for debugging, not routine use.

### `input` — transform or handle user input

Fires when the user submits input, *after* extension commands are checked but *before* skill/template expansion.

```ts
pi.on("input", async (event, ctx) => {
  // event.text    — raw input
  // event.images  — attached images
  // event.source  — "interactive" | "rpc" | "extension"

  // Shortcut: rewrite
  if (event.text.startsWith("?quick ")) {
    return {
      action: "transform",
      text: `Respond briefly: ${event.text.slice(7)}`,
    };
  }

  // Handle without LLM
  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  // Skip extension-injected messages
  if (event.source === "extension") {
    return { action: "continue" };
  }
});
```

Return values:

- `{ action: "continue" }` — default; pass through.
- `{ action: "transform", text?, images? }` — modify and pass through. Chains across handlers.
- `{ action: "handled" }` — skip the agent entirely. First handler to return wins.

### `turn_start` / `turn_end`

Fires per turn (one LLM response + its tool calls).

```ts
pi.on("turn_end", async (event, ctx) => {
  // event.turnIndex
  // event.message      — the assistant message
  // event.toolResults  — tool results from this turn
  await checkpoint(ctx.sessionManager.getLeafId());
});
```

Good for git checkpointing, usage logging, per-turn housekeeping.

### `session_before_compact` / `session_compact`

Fires on `/compact` or auto-compaction. `session_before_compact` can cancel or provide a custom summary:

```ts
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, signal } = event;

  // Cancel compaction
  if (shouldNotCompact()) return { cancel: true };

  // Provide custom summary
  const summary = await myCustomSummarizer(preparation.messages, { signal });
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    },
  };
});
```

### `session_before_switch` / `session_before_fork`

Fires before `/new`, `/resume`, or `/fork`. Can cancel:

```ts
pi.on("session_before_switch", async (event, ctx) => {
  if (event.reason === "new" && hasUnsavedWork) {
    const ok = await ctx.ui.confirm("Unsaved work", "Really start a new session?");
    if (!ok) return { cancel: true };
  }
});
```

After a successful switch, `session_shutdown` fires for the old instance, then `session_start` fires for the new one with `reason` and `previousSessionFile`.

### `user_bash` — intercept `!` / `!!` commands

Fires when the user types `!cmd` or `!!cmd` in the editor. Can intercept:

```ts
import { createLocalBashOperations } from "@mariozechner/pi-coding-agent";

pi.on("user_bash", (event, ctx) => {
  // event.command, event.excludeFromContext (true for !!), event.cwd

  // Wrap the built-in backend
  const local = createLocalBashOperations();
  return {
    operations: {
      exec(command, cwd, options) {
        return local.exec(`source ~/.profile\n${command}`, cwd, options);
      },
    },
  };
});
```

Three return shapes:
- `{ operations }` — swap the backend (SSH, container, etc.).
- `{ result: { output, exitCode, cancelled, truncated } }` — return the result directly, skipping execution.
- Nothing — default local execution.

### `model_select`

Fires when the model changes via `/model`, Ctrl+P, or session restore:

```ts
pi.on("model_select", async (event, ctx) => {
  // event.model, event.previousModel, event.source ("set" | "cycle" | "restore")
  ctx.ui.setStatus("model", `${event.model.provider}/${event.model.id}`);
});
```

Good for status bars and model-specific initialisation.

## Event handler return summary

| Event                        | Return value semantics                                                |
|------------------------------|------------------------------------------------------------------------|
| `before_agent_start`         | `{ message?, systemPrompt? }` — both optional, chained across handlers |
| `tool_call`                  | `{ block: true, reason? }` or nothing. Mutate `event.input` in place.  |
| `tool_result`                | Partial patch `{ content?, details?, isError? }` or nothing. Chained.  |
| `context`                    | `{ messages }` or nothing                                              |
| `before_provider_request`    | New payload or `undefined`. Chained.                                   |
| `input`                      | `{ action: "continue" \| "transform" \| "handled", text?, images? }`     |
| `session_before_switch`      | `{ cancel: true }` or nothing                                          |
| `session_before_fork`        | `{ cancel: true }` or `{ skipConversationRestore: true }` or nothing   |
| `session_before_compact`     | `{ cancel: true }` or `{ compaction }` or nothing                      |
| `session_before_tree`        | `{ cancel: true }` or `{ summary }` or nothing                         |
| `user_bash`                  | `{ operations }` or `{ result }` or nothing                            |
| All others                   | No meaningful return value                                             |

## When to use which hook

| Goal                                  | Hook                          |
|---------------------------------------|-------------------------------|
| Permission gate (refuse dangerous)    | `tool_call`                   |
| Audit logging                         | `tool_call` + `tool_result`   |
| Context window management / RAG       | `context`                     |
| Add persistent context per-turn       | `before_agent_start`          |
| Git checkpoint per turn               | `turn_end`                    |
| Custom compaction                     | `session_before_compact`      |
| Rehydrate state from session          | `session_start`               |
| Cleanup on exit                       | `session_shutdown`            |
| Capture user commands before LLM      | `input`                       |
| Remote execution (SSH, sandbox)       | `user_bash` + tool operations |
| Inspect provider payload              | `before_provider_request`     |
| Update status bar on model change     | `model_select`                |

## Performance notes

`context` and `before_provider_request` run on every turn and every LLM call. Keep them cheap. Heavy work (summarisation, external calls) should happen in `turn_end`, `session_before_compact`, or be gated behind a flag you toggle sparingly.
