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

Include `emit_summary` plus whatever sandbox read verbs the child
role needs (paired with cwd-guard via `makeCwdGuard({verbs:[...]})`
on the parent side). For recon:

```
sandbox_ls,sandbox_read,sandbox_grep,sandbox_glob,emit_summary
```

Never add built-in `read`/`ls`/`grep`/`glob`/`write`/`edit` (all
forbidden), `bash`, `stage_write`, `sandbox_write`, or `sandbox_edit`
in a composition that uses `emit_summary` as its primary output
channel — they undermine the "structured-output-only" contract.

## Parent-side wiring

Adds `emit-summary.parentSide` to the `delegate()` call's
`components` array. `delegate()` contributes the `emit_summary`
tool token, pushes `-e <emit-summary.ts>` into the child argv,
and routes `tool_execution_start` events for `emit_summary`
through `parentSide.harvest` (pushes `{title, body}` pairs into
the per-run state). `parentSide.finalize` enforces the
`MAX_SUMMARY_BODY_BYTES = 8 KB` per-body cap and returns
`{summaries, skips}`; the caller decides what to do with the
list (persist each to `.pi/scratch/<title>.md` in a recon shape,
or concatenate into a brief for a sequential second phase).

```ts
import { parentSide as EMIT_SUMMARY } from "../components/emit-summary.ts";
import { delegate } from "../lib/delegate.ts";

const result = await delegate(ctx, {
  components: [EMIT_SUMMARY],   // read-only recon; no cwd-guard needed
  prompt,
});
const { summaries } =
  result.byComponent.get("emit-summary") as
    { summaries: { title: string; body: string; byteLength: number }[] };
```

`PI_SANDBOX_ROOT` is NOT set on an emit-summary-only child —
`emit_summary` has no filesystem contact. Compositions that
combine it with write-capable components (sequential phase-2
drafter) set the env var only on the drafter spawn, which
`cwd-guard.parentSide.env` supplies automatically.
