# Command recipe: `pi.registerCommand`

Commands are what the **user** types in the TUI, as `/name [args]`. They're for operations the user invokes consciously — not for things the LLM should decide to do.

## Minimal working example

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("stats", {
    description: "Show token and cost stats for the current session",
    handler: async (args, ctx) => {
      const usage = ctx.getContextUsage();
      if (!usage) {
        ctx.ui.notify("No usage data yet", "warn");
        return;
      }
      ctx.ui.notify(`Context: ${usage.tokens.toLocaleString()} tokens`, "info");
    },
  });
}
```

The user runs `/stats` in the TUI, the handler fires.

## Fields

- `description` — shown in `/help` and in autocomplete. Keep it one line.
- `handler(args, ctx)` — `args` is the **raw string** after the command name (everything after `/stats `). Parse it yourself.
- `aliases?: string[]` — optional alternate names.

## Argument parsing

Pi hands you the raw string. You do the parsing. For anything non-trivial, use a real parser; for simple cases, split on whitespace:

```ts
handler: async (args, ctx) => {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const [subcommand, ...rest] = parts;
  switch (subcommand) {
    case "on":   return enable(ctx);
    case "off":  return disable(ctx);
    case "":     return status(ctx);
    default:     ctx.ui.notify(`Unknown: ${subcommand}`, "error");
  }
},
```

If you find yourself parsing flags like `--force`, consider whether this should be a tool (LLM-callable with a schema) instead.

## Commands vs tools — the distinction

| | Command | Tool |
|---|---|---|
| Who invokes | User typing `/name` | LLM deciding to call |
| Args format | Raw string | Schema-validated object |
| Primary output | Side effect (UI, state) | Text into context |
| Use when | User wants deterministic action | LLM decides based on task |

If the user and the LLM both plausibly invoke the same capability, register **both** — a thin command wrapper around the tool, or vice versa. That's a common pattern:

```ts
pi.registerCommand("reload-runtime", {
  description: "Reload extensions, skills, prompts, and themes",
  handler: async (_args, ctx) => {
    await ctx.reload();
  },
});

pi.registerTool({
  name: "reload_runtime",
  label: "Reload Runtime",
  description: "Reload extensions, skills, prompts, and themes",
  parameters: Type.Object({}),
  async execute() {
    pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
    return { content: [{ type: "text", text: "Queued /reload-runtime." }] };
  },
});
```

Note `pi.sendUserMessage(..., { deliverAs: "followUp" })` — how a tool schedules a command for the next turn.

## Interactive commands via `ctx.ui`

Commands often need input. Use `ctx.ui` rather than rolling your own prompts:

```ts
handler: async (_args, ctx) => {
  const choice = await ctx.ui.select("Pick an environment", [
    { label: "Staging", value: "staging" },
    { label: "Production", value: "production" },
  ]);
  if (!choice) return; // user cancelled
  const confirmed = await ctx.ui.confirm("Deploy?", `Deploy to ${choice}?`);
  if (!confirmed) return;
  await deploy(choice);
  ctx.ui.notify(`Deployed to ${choice}`, "info");
},
```

## Top failure modes

1. **Blocking the TUI with sync work.** Always `async` the handler and await I/O.
2. **Not handling cancel.** If you use `ctx.ui.select`/`input`, they return `undefined` on cancel. Check and return early.
3. **Using `console.log`.** Mangles the TUI. Use `ctx.ui.notify`.
