# Part: `review.ts`

**Location:** `pi-sandbox/.pi/components/review.ts`

## What it does

Pi extension that registers a **stub** tool `review({file_path,
verdict, feedback?})` where `verdict` is a `StringEnum(["approve",
"revise"])`. The `execute` is a no-op; the parent harvests each
verdict from the child's NDJSON stream.

The point: a reviewer LLM renders `approve`/`revise` on a staged
draft; the parent treats `approve` as "promotable" and `revise` as
"re-dispatch the drafter with this feedback."

## When to use

Only inside the `orchestrator` pattern. A delegator LLM holds two
stubs — `run_deferred_writer` (dispatch) and `review` (verdict) —
and the parent harvests both. A pattern without multiple sub-tasks
and a review loop has no use for `review`.

## When NOT to use

- `drafter-with-approval` pattern. The user gate is a human
  (`ctx.ui.confirm`), not an LLM. Don't stack both — either the
  human is the gate or the reviewer LLM is, not both.
- Any pattern with only one drafter and no revision loop. Review
  stub + one-and-done drafter is an over-engineered shape.

## Load mechanism

```ts
const REVIEW_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "review.ts",
);
```

Loaded into the delegator child alongside `run-deferred-writer.ts`:

```ts
spawn("pi", [
  "-e", CWD_GUARD,
  "-e", RUN_DEFERRED_WRITER_TOOL,
  "-e", REVIEW_TOOL,
  "--tools", "run_deferred_writer,review",
  "--no-extensions",
  "--mode", "rpc",
  …,
]);
```

Note the delegator uses `--mode rpc` (persistent session), not
`--mode json`. See `patterns/orchestrator.md` for the full spawn
shape.

## Required `--tools` allowlist

The delegator's allowlist is exactly `run_deferred_writer,review`.
No read/write verbs — the delegator decides *what* to run and *what
to accept*, nothing else.

## Harvesting in the parent

Each `tool_execution_start` for `review`:

```json
{"type":"tool_execution_start","toolName":"review","args":{"file_path":"…","verdict":"approve|revise","feedback":"…"}}
```

On `approve`: mark the staged draft promotable. On `revise`:
re-dispatch the drafter for that task with
`"Revision feedback: ${feedback}"` appended to the task string. Cap
at 3 iterations per subtask — past that, bail with a `notify` and
still surface the accumulated cost.

## Gotcha

`StringEnum` for `verdict` must be imported from
`@mariozechner/pi-ai`, not `Type.StringEnum(...)` (there's no such
method on TypeBox's `Type`). This is already correct in
`pi-sandbox/.pi/components/review.ts`; don't paraphrase the import.
