# Component: `run-deferred-writer.ts`

**Location:** `pi-sandbox/.pi/components/run-deferred-writer.ts`

## What it does

Pi extension that registers a **stub** tool
`run_deferred_writer({task})`. The tool's `execute` is a no-op —
the parent harvests each `tool_execution_start` event for
`run_deferred_writer` to recover the `task` string, then runs an
actual drafter child (single-spawn `cwd-guard + stage-write` shape)
per harvested task — typically in parallel via `Promise.all`.

This is the dispatch verb for the
`rpc-delegator-over-concurrent-drafters` topology: the delegator
LLM decides *what* sub-tasks to fan out; the parent owns the actual
fan-out mechanics.

## When to use

- Inside `rpc-delegator-over-concurrent-drafters` topology, paired
  with `review`. Loaded into the delegator's allowlist alongside
  `review` only.

## When NOT to use

- Single-drafter shapes. Calling `run_deferred_writer` once with no
  fan-out is a topology mismatch — use `single-spawn` with
  `cwd-guard + stage-write` instead.
- Outside an RPC delegator. The dispatch verb only makes sense
  when one persistent LLM session is choosing how many drafters to
  run; calling it from a one-shot `--mode json` child loses the
  delegator's ability to react to draft outcomes.

## Load mechanism

```ts
const RUN_DEFERRED_WRITER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "run-deferred-writer.ts",
);
```

Loaded into the delegator alongside `review.ts` and `cwd-guard.ts`:

```ts
spawn("pi", [
  "-e", CWD_GUARD,
  "-e", RUN_DEFERRED_WRITER,
  "-e", REVIEW,
  "--tools", "run_deferred_writer,review",
  "--mode", "rpc",
  ...,
]);
```

## Required `--tools` allowlist contribution

```
run_deferred_writer
```

The delegator's full allowlist is `run_deferred_writer,review` —
nothing else.

## Parent-side wiring template

- **Event anchor:** `event.type === "tool_execution_start" &&
  event.toolName === "run_deferred_writer"`.
- **Args destructuring:** `const { task } = event.args as {
  task: string };`.
- **State shape:** `const dispatched: Array<{ task: string;
  draftPromise: Promise<DrafterResult> }> = [];`. Each call
  spawns one drafter child (`cwd-guard + stage-write`,
  single-spawn shape) and pushes its promise.
- **Finalize behavior:**
  1. `await Promise.all(dispatched.map((d) => d.draftPromise))`
     to gather all drafter results before returning control to
     the delegator.
  2. For each drafter result, feed the staged file_path(s) back
     into the delegator's RPC stdin as a follow-up prompt asking
     for a `review` verdict.
  3. After verdicts arrive (see `parts/review.md`), promote
     `approve`d drafts via the standard stage-write promotion
     path (rail 6).
  4. Update the dashboard widget on each phase boundary
     (dispatched / drafted / reviewed / promoted) per rail 11.

### Spawn snippet for the dispatched drafter (per task)

```ts
const drafter = spawn(
  "pi",
  [
    "-e", CWD_GUARD,
    "-e", STAGE_WRITE,
    "--tools", "stage_write,ls",
    "--no-extensions",
    "--mode", "json",
    "--provider", "openrouter",
    "--model", TASK_MODEL,
    "--no-session",
    "--thinking", "off",
    "-p", task,
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: sandboxRoot,
    env: { ...process.env, PI_SANDBOX_ROOT: sandboxRoot },
  },
);
```

## Canonical assembled example

`pi-sandbox/.pi/extensions/delegated-writer.ts` wires
`run_deferred_writer` + `review` into the full
`/delegated-writer <task>` slash command with RPC delegator,
parallel drafter dispatch, and a per-task feedback map. Use it as
the reference whenever the wiring template above leaves something
ambiguous.
