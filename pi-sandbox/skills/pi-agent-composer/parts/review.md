# Component: `review.ts`

**Location:** `pi-sandbox/.pi/components/review.ts`

## What it does

Pi extension that registers a **stub** tool `review({file_path,
verdict, feedback?})` where `verdict` is a `StringEnum(["approve",
"revise"])`. The `execute` is a no-op; the parent harvests each
verdict from the child's NDJSON stream.

The point: a reviewer LLM renders `approve`/`revise` on a staged
draft; the parent treats `approve` as "promotable" and `revise`
as "re-dispatch the drafter with this feedback."

## When to use

- Inside `rpc-delegator-over-concurrent-drafters` topology, paired
  with `run-deferred-writer` (full orchestrator). Delegator
  dispatches drafters and reviews their drafts.
- Inside the same topology with a single drafter (no
  `run-deferred-writer` in the set is also possible — the cascade
  in `procedure.md` §3 routes any `review`-bearing set to RPC).

When `review` is in the component set, the LLM verdict replaces
the human gate: `ctx.ui.confirm` does NOT fire.

## When NOT to use

- Single-drafter human-gated flows. Use `stage-write` alone (with
  `cwd-guard`) and let `ctx.ui.confirm` do the gating — don't
  stack both gates.
- Compositions with no revision loop. Review stub + one-and-done
  drafter is an over-engineered shape; if there's no chance of
  `revise`, the verdict adds latency without value.

## Load mechanism

```ts
const REVIEW = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "review.ts",
);
```

Loaded into the delegator child alongside `run-deferred-writer`:

```ts
spawn("pi", [
  "-e", CWD_GUARD,
  "-e", RUN_DEFERRED_WRITER,
  "-e", REVIEW,
  "--tools", "run_deferred_writer,review",
  "--no-extensions",
  "--mode", "rpc",
  "--no-session",
  "--thinking", "off",
  "--provider", "openrouter",
  "--model", LEAD_MODEL,
]);
```

Note `--mode rpc` (persistent session), not `--mode json`. See
`compositions.md` §`rpc-delegator-over-concurrent-drafters`.

## Required `--tools` allowlist contribution

```
review
```

For the orchestrator shape, the delegator's allowlist is exactly
`run_deferred_writer,review` — no read/write verbs. The delegator
decides *what* to dispatch and *what to accept*, nothing else.

## Parent-side wiring template

- **Event anchor:** `event.type === "tool_execution_start" &&
  event.toolName === "review"`.
- **Args destructuring:** `const { file_path: reviewedPath,
  verdict, feedback } = event.args as { file_path: string;
  verdict: "approve" | "revise"; feedback?: string };`.
- **State shape:** `const verdicts = new Map<string, { verdict:
  "approve" | "revise"; feedback?: string }>();` keyed by the
  staged draft's path. Also track `iterations` per file_path,
  capped at `MAX_REVIEW_ITERATIONS` (typ. 3).
- **Finalize behavior:**
  - On `approve`: mark the staged draft promotable; pass through
    to the stage-write finalize step.
  - On `revise`: re-dispatch the drafter for that file_path with
    `"Revision feedback: " + feedback` appended to the task
    string. After `MAX_REVIEW_ITERATIONS`, bail with a `notify`
    naming the file_path and surface accumulated cost.

## Gotcha

`StringEnum` for `verdict` must be imported from
`@mariozechner/pi-ai`, not `Type.StringEnum(...)` (there's no
such method on TypeBox's `Type`). This is already correct in
`pi-sandbox/.pi/components/review.ts`; don't paraphrase the
import.
