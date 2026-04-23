# Part: `emit-summary.ts`

**Location:** `pi-sandbox/.pi/components/emit-summary.ts`

## What it does

Pi extension that registers a **stub** tool
`emit_summary({title, body})`. The tool's `execute` is a no-op — it
returns a confirm message but does NOT touch disk. The parent
harvests each `tool_execution_start` event for `emit_summary` from
the child's NDJSON stdout (`--mode json`) to recover
`{title, body}`.

`emit_*` is the structured-output counterpart to `stage_*`: no side
effect is deferred, the child is simply handing the parent a named
piece of structured text to display / persist / feed into a next
phase. See the "Naming conventions" section in `SKILL.md`.

## When to use

- **recon pattern:** the child walks a directory / codebase and
  hands back one or more structured summaries. Replaces harvesting
  free-form assistant text from `message_end` events.
- **scout-then-draft pattern:** the recon phase emits summaries
  that the parent assembles into a handoff brief for the drafter
  phase.

## When NOT to use

- Any pattern where the child needs to return a *side effect* (a
  file write, an exec, an HTTP call). Use `stage_*` for those.
- Patterns where the parent genuinely wants the child's final
  assistant prose (there are none in this library today).

## Load mechanism

```ts
const EMIT_SUMMARY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "emit-summary.ts",
);
```

Pass `-e <EMIT_SUMMARY>` to the child. Resolve the path relative to
the parent extension's own `import.meta.url`, NOT from `$HOME` or
the user's cwd.

## Required `--tools` allowlist

Include `emit_summary` plus whatever read-only verbs the child role
needs. For recon:

```
ls,read,grep,glob,emit_summary
```

Never add `write`, `edit`, `stage_write`, or `bash` in a pattern
that uses `emit_summary` as its primary output channel — they
undermine the "structured-output-only" contract.

## Harvesting in the parent

The child speaks NDJSON on stdout (`--mode json`). Each time the
LLM calls `emit_summary`, the parent sees:

```json
{"type":"tool_execution_start","toolName":"emit_summary","args":{"title":"…","body":"…"}}
```

Accumulate `{title, body}` into an array. Apply a per-body byte cap
(`Buffer.byteLength(body, "utf8") > SUMMARY_BYTE_CAP`) and
optionally a total-across-all-summaries cap before persisting.

## Spawn snippet

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
  { stdio: ["ignore", "pipe", "pipe"], cwd: sandboxRoot },
);
```

Note: `PI_SANDBOX_ROOT` is NOT required here — `emit_summary` has
no filesystem contact and the child's allowlist is read-only.
Patterns that combine `emit_summary` with write-capable parts
(e.g. `scout-then-draft`'s drafter phase) set `PI_SANDBOX_ROOT`
only on the spawn that loads `cwd-guard.ts`.

## Canonical usage

`patterns/recon.md`'s skeleton is the reference wiring for
`emit_summary`. The drafter phase in `patterns/scout-then-draft.md`
does NOT use it — `stage_write` is the right choice there because
the drafter proposes files to persist, not structured summaries to
display.
