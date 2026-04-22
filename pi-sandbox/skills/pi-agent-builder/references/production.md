# Production hardening

Going from a working extension to one you'd ship. The differences cluster in six areas: inputs, secrets, timeouts, cancellation, output, and reload safety.

## Inputs — validate beyond the schema

TypeBox checks shape and basic types. It does not check *semantics*. Add real validation inside `execute`:

```ts
async execute(toolCallId, params, onUpdate, ctx, signal) {
  // Schema said params.path is a string. Is it a real, safe path?
  const path = path.resolve(params.path);
  const projectRoot = path.resolve(".");
  if (!path.startsWith(projectRoot + path.sep)) {
    return {
      content: [{ type: "text", text: `Error: path is outside project root` }],
      isError: true,
    };
  }

  if (!await exists(path)) {
    return {
      content: [{ type: "text", text: `Error: ${path} does not exist` }],
      isError: true,
    };
  }

  // ...
}
```

Common checks: path traversal, absolute vs relative, URL scheme whitelisting, size limits on string params, enum values you can't encode in the schema.

## Secrets

- Read from environment variables; never bake them into the extension source.
- Check for the secret's presence at `session_start` and `notify` the user if missing (don't just silently fail later).
- Redact before logging:

```ts
function redact(s: string): string {
  return s.replace(/\b(sk|pk|ak)-[A-Za-z0-9_-]{20,}\b/g, "***");
}
```

- If you persist state (`appendEntry`, files), scrub secrets out first.
- Consider if tool output contains secrets — they'd go into context and could show up in compaction summaries.

## Timeouts on network and subprocess calls

Default-wide-open is a production bug:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30_000);
// Compose with the tool's signal so user cancel also fires
signal.addEventListener("abort", () => controller.abort());

try {
  const res = await fetch(url, { signal: controller.signal });
  // ...
} catch (err: any) {
  if (err.name === "AbortError") {
    return {
      content: [{ type: "text", text: "Request timed out after 30s" }],
      isError: true,
    };
  }
  throw err;
} finally {
  clearTimeout(timer);
}
```

Pick timeouts per-operation. A status check: 5s. A deploy: several minutes. Document your timeouts in the tool description — users will ask.

## Always honor `AbortSignal`

Every `execute` receives a `signal`. Pass it to every `fetch`, every `spawn`, every long-running promise. When the user cancels, the entire tool stack should stop:

```ts
async execute(toolCallId, params, onUpdate, ctx, signal) {
  const res = await fetch(url, { signal });
  const child = spawn("long-task", args, { signal });
  // When signal aborts, both unwind automatically
}
```

Tools that ignore `signal` leave zombie subprocesses and confuse the user.

## Output — truncate, structure, label

Tool results enter context. Rules:

- **Hard cap** at some sane size (e.g. 32KB text). If you exceed, truncate with a clear marker:

```ts
const MAX = 32 * 1024;
if (text.length > MAX) {
  text = text.slice(0, MAX) + `\n\n[Truncated: ${text.length - MAX} more characters. Full output at ${path}]`;
}
```

- **Structured over unstructured** where feasible. LLMs parse tables and labeled sections better than wall-of-text.
- **Separate signal from noise.** If 95% of the output is boilerplate, extract the 5% that matters for the `content` and stash the rest in `details` or a file.

## Errors — legible and actionable

The LLM reads your error messages. Write them for a reader who will try to recover:

```ts
// Bad
return { content: [{ type: "text", text: "Error" }], isError: true };

// Good
return {
  content: [{ type: "text", text:
    `Deploy failed: authentication rejected by ${host}.\n` +
    `Verify DEPLOY_TOKEN is set and has push scope. ` +
    `Run \`pi config show deploy\` to inspect current settings.`
  }],
  isError: true,
  details: { host, errorCode: "AUTH_FAILED" },
};
```

The LLM can relay this to the user and attempt recovery.

## Reload safety — cleanup in `session_shutdown`

Every resource you allocate outside a tool call's lifetime needs cleanup:

```ts
const cleanups: (() => void | Promise<void>)[] = [];

export default function (pi: ExtensionAPI) {
  const ws = new WebSocket(url);
  cleanups.push(() => ws.close());

  const interval = setInterval(poll, 10_000);
  cleanups.push(() => clearInterval(interval));

  const watcher = fs.watch(path, handler);
  cleanups.push(() => watcher.close());

  pi.on("session_shutdown", async () => {
    for (const fn of cleanups) await fn();
  });
}
```

Hot-reload creates a new extension instance without destroying the old one's runtime. Without cleanup, you leak connections, watchers, and timers.

## Telemetry / logging

If you want to understand how your extension performs in the wild:

- Log to a file in `~/.pi/agent/logs/<your-ext>.log` — don't touch stdout/stderr (TUI).
- Rotate logs (size or age).
- Never log PII or secrets without explicit user opt-in.
- Include the tool name, params hash (not full params), duration, result status.

## Safe defaults for dangerous operations

If your extension can destroy state (delete files, revoke tokens, drop tables), default to **confirm**:

```ts
const confirmed = await ctx.ui.confirm(
  "Irreversible action",
  `About to delete ${target}. Continue?`
);
if (!confirmed) {
  return {
    content: [{ type: "text", text: "User declined the destructive action." }],
  };
}
```

The LLM sees that the user declined and can propose an alternative. Never auto-confirm on behalf of the user, even if the LLM has `autoConfirm: true` in params — that's a lie the LLM might tell itself.

## Rate limits and backpressure

If your extension hits a rate-limited API:

- Implement retries with exponential backoff + jitter.
- On repeated failures, return the rate limit info in the error message so the user can decide to wait.
- Cache results where possible — the LLM will happily call the same tool three times in a row if it forgets what it got.

## Dependencies — minimize

Every dep is a risk (supply chain, version conflicts, runtime failures under `tsx`). Prefer:

- Node built-ins (`node:fs`, `node:child_process`, `node:crypto`).
- Pi's own types and helpers.
- Widely-used, well-maintained packages only.

Pin exact versions. Audit `npm ls` before publishing.

## Checklist before shipping

- [ ] All inputs validated beyond schema shape
- [ ] Secrets read from env, redacted in logs, not persisted naively
- [ ] All network calls have timeouts
- [ ] All long operations honor `signal`
- [ ] Outputs truncated to a hard cap with clear markers
- [ ] Errors are legible and actionable for the LLM
- [ ] `session_shutdown` cleans up every long-lived resource
- [ ] `/reload` cycle tested (call → modify → reload → call → no leaks)
- [ ] Dangerous operations require confirmation
- [ ] README documents security surface and required env
- [ ] Evals exist for at least the trigger and basic behavior
