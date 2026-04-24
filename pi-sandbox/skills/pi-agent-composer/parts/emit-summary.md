# Component: `emit-summary.ts`

**Location:** `pi-sandbox/.pi/components/emit-summary.ts`

## What it does

Pi extension that registers a **stub** tool
`emit_summary({title, body})`. The tool's `execute` is a no-op —
it returns a confirm message but does NOT touch disk. The parent
harvests each `tool_execution_start` event for `emit_summary` from
the child's NDJSON stdout (`--mode json`) to recover
`{title, body}`.

`emit_*` is the structured-output counterpart to `stage_*`: no
side effect is deferred, the child is simply handing the parent a
named piece of structured text to display / persist / feed into a
next phase.

## When to use

- **Recon-style single-spawn:** the child walks a directory /
  codebase and hands back one or more structured summaries.
  Replaces harvesting free-form assistant text from `message_end`.
- **`sequential-phases-with-brief` topology, phase 1:** the recon
  phase emits summaries that the parent assembles into a handoff
  brief for the drafter phase.

## When NOT to use

- Any composition where the child needs to return a *side effect*
  (a file write, an exec, an HTTP call). Use `stage_write` for
  those.
- Compositions where the parent genuinely wants the child's final
  assistant prose (none in this library today).

## Load mechanism

```ts
const EMIT_SUMMARY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "emit-summary.ts",
);
```

Pass `-e <EMIT_SUMMARY>` to the child. Resolve the path relative
to the parent extension's own `import.meta.url`, NOT from `$HOME`
or the user's cwd.

## Required `--tools` allowlist contribution

Include `emit_summary` plus whatever read-only verbs the child
role needs. For recon:

```
ls,read,grep,glob,emit_summary
```

Never add `write`, `edit`, `stage_write`, or `bash` in a
composition that uses `emit_summary` as its primary output channel
— they undermine the "structured-output-only" contract.

## Parent-side wiring template

- **Event anchor:** `event.type === "tool_execution_start" &&
  event.toolName === "emit_summary"`.
- **Args destructuring:** `const { title, body } = event.args as
  { title: string; body: string };`.
- **State shape:** `const summaries: Array<{ title: string; body:
  string }> = [];`. Apply per-body byte cap
  (`Buffer.byteLength(body, "utf8") <= SUMMARY_BYTE_CAP`,
  typically 16 KB) on push; reject and log if exceeded.
- **Finalize behavior** depends on topology:
  - **single-spawn (recon):** persist each summary to
    `.pi/scratch/<safe-title>.md` (or join into one file). Final
    `ctx.ui.notify` lists the persisted paths.
  - **sequential-phases-with-brief:** join the summaries into a
    brief — `summaries.map((s) => "## " + s.title + "\n" + s.body).join("\n\n")`
    — assert the joined `Buffer.byteLength` is within
    `BRIEF_MAX_BYTES`, then pass the brief into phase 2's prompt.

### Spawn snippet

```ts
const child = spawn(
  "pi",
  [
    "-e", EMIT_SUMMARY,
    "--tools", "ls,read,grep,glob,emit_summary",
    "--no-extensions",
    "--mode", "json",
    "--provider", "openrouter",
    "--model", MODEL,
    "--no-session",
    "--thinking", "off",
    "-p", agentPrompt,
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: sandboxRoot,
  },
);
```

`PI_SANDBOX_ROOT` is NOT set on this spawn — `emit_summary` has
no filesystem contact and the child's allowlist is read-only.
Compositions that combine `emit_summary` with write-capable
components (e.g. `sequential-phases-with-brief`'s phase 2) set
`PI_SANDBOX_ROOT` only on the spawn that loads `cwd-guard.ts`.
