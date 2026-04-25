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

## Parent-side wiring

Orchestrator-only — `run_deferred_writer` lives inside the RPC
delegator session, parallel to `review`. The delegator spawn
itself stays custom (`--mode rpc`), but the orchestrator imports
`run-deferred-writer.parentSide.harvest` to extract dispatched
task strings from the delegator's stdout, and runs the drafter
fan-out through `delegate(autoPromote: false)` — so each drafter
gets the same rails set every other `delegate()` call enjoys.

```ts
import { parentSide as CWD_GUARD } from "../components/cwd-guard.ts";
import { parentSide as STAGE_WRITE } from "../components/stage-write.ts";
import { parentSide as RUN_DEFERRED_WRITER } from "../components/run-deferred-writer.ts";
import { delegate, promote } from "../lib/delegate.ts";

// Per-phase state from the delegator RPC session:
const dispatchState = RUN_DEFERRED_WRITER.initialState();
// ...inside the RPC event loop:
RUN_DEFERRED_WRITER.harvest(event, dispatchState);
// ...after the dispatch phase ends (agent_end):
const { tasks } = await RUN_DEFERRED_WRITER.finalize(dispatchState, fctx);

// Drafter fan-out via delegate(autoPromote: false) — LLM review is
// the gate, not ctx.ui.confirm:
const drafterResults = await Promise.all(
  tasks.map((task) =>
    delegate(ctx, {
      components: [CWD_GUARD, STAGE_WRITE],
      prompt: task,
      autoPromote: false,
    }),
  ),
);

// After the review phase verdicts come back, promote the approved
// plans with the exported helper:
const { promoted } = promote(ctx, approvedPlans);
```

Dashboard updates on every phase boundary (dispatched / drafted /
reviewed / promoted) via `ctx.ui.setWidget` + `ctx.ui.setStatus`
per rail 11.

## Canonical assembled example

`pi-sandbox/.pi/extensions/delegated-writer.ts` wires
`run_deferred_writer` + `review` into the full
`/delegated-writer <task>` slash command with RPC delegator,
parallel drafter dispatch, and a per-task feedback map. Use it as
the reference whenever the wiring template above leaves something
ambiguous.
