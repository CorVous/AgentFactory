# Pattern: `orchestrator`

**When to use:** user wants the agent to break a goal into multiple
sub-tasks, dispatch a drafter per sub-task, and have an LLM
reviewer approve or revise each draft before anything is
promoted. A **delegator LLM** holds two stubs (`run_deferred_writer`
for dispatch, `review` for verdicts); the parent harvests both from
NDJSON and drives the real pipeline.

This is the most complex pattern here. Prefer a simpler pattern
unless the prompt explicitly asks for orchestration. In particular,
if the user's real shape is "one survey + one draft" (look at what's
there, then write the missing piece), reach for `scout-then-draft`
first — orchestrator's delegator LLM and revise loop are overkill
for that case.

## Short-prompt signals that match

- "break the goal into sub-tasks and have an LLM check each"
- "delegator / orchestrator that dispatches and reviews"
- "iterate: draft, review, revise, repeat"
- "multiple drafters in parallel then an LLM-judge gate"

## Parts

In load order on the **delegator** child:

1. `cwd-guard.ts` — even though the delegator has no write verbs,
   load cwd-guard so any future edits to the pattern inherit the
   safety rail by default.
2. `run-deferred-writer.ts` — **not** a reusable library part. It
   lives at `pi-sandbox/.pi/components/run-deferred-writer.ts` as a
   committed artifact, but it is *specific* to this pattern. It
   registers a stub `run_deferred_writer({task})` tool whose
   execute is a no-op; the parent harvests each
   `tool_execution_start` for `run_deferred_writer` and
   dispatches a real drafter child for that task.
3. `review.ts` — stub verdict tool. See `parts/review.md`.

On each **drafter** child the pattern dispatches:

1. `cwd-guard.ts`
2. `stage-write.ts` — drafts stage into parent memory the same way
   as `drafter-with-approval`, but the gate is the reviewer LLM,
   not `ctx.ui.confirm`.

## `--tools` allowlist

- **Delegator:** `run_deferred_writer,review` — nothing else. The
  delegator does no fs work; cwd-guard is still loaded on the spawn
  as defense-in-depth (`PI_SANDBOX_VERBS=""` so it registers zero
  sandbox tools).
- **Drafter:** `stage_write,sandbox_ls` (or
  `stage_write,sandbox_ls,sandbox_read` if explicitly needed). NO
  built-in `read`/`ls`/`grep`/`glob`/`write`/`edit`, no `bash`, and
  NO `sandbox_write`/`sandbox_edit` — `stage_write` is the only
  write channel.

## Model tiers

- **Delegator:** `$LEAD_MODEL`. Review and dispatch judgment —
  solid reasoning but not frontier.
- **Drafter:** `$TASK_MODEL`. Bulk writing.
- **Optional planner** (if the delegator itself is driven by an
  upstream planner): `$PLAN_MODEL`. Not part of the canonical
  pattern.

## Mode

**RPC**, not json. The delegator keeps one continuous conversation
across dispatch → review → revise phases; `--mode json -p` would
respawn per phase and lose the LLM's memory of what it's
reviewing. See `pi-agent-builder/references/subagent-recipe.md`
→ *Persistent RPC sub-agents* for the protocol details.

## Canonical assembled example

`pi-sandbox/.pi/extensions/delegated-writer.ts`. The implementation
is ~500 lines — dashboard widget, status line, cost tracking,
parallel drafter dispatch, revise loop with iteration cap. The
skeleton below is the *wiring shape* only; for any non-trivial
orchestrator, open the canonical file and adapt it instead of
re-building from this skeleton.

## Skeleton (delegator wiring shape — consult `delegated-writer.ts` for the full version)

Save this file as `.pi/extensions/<TODO:CMD_NAME>.ts` under the
project's sandbox directory. Files at the cwd root are NOT
auto-discovered by pi and won't register.

```ts
// .pi/extensions/TODO:CMD_NAME.ts — orchestrator with LLM review loop.
// NOTE: this skeleton shows the wiring shape; see
// pi-sandbox/.pi/extensions/delegated-writer.ts for the full reference
// (dashboard widget, status line, cost accumulation, revise loop).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_REVISE_ITERATIONS = 3;
const DELEGATOR_TIMEOUT_MS = 600_000;
const DRAFTER_TIMEOUT_MS = 120_000;

const CWD_GUARD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "cwd-guard.ts",
);
const STAGE_WRITE_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "stage-write.ts",
);
const RUN_DEFERRED_WRITER_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "run-deferred-writer.ts",
);
const REVIEW_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "review.ts",
);

export default function (pi: ExtensionAPI) {
  pi.registerCommand("TODO:CMD_NAME", {
    description: "TODO:CMD_DESCRIPTION",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /TODO:CMD_NAME <goal>", "warning");
        return;
      }
      const TASK_MODEL = process.env.TASK_MODEL;
      const LEAD_MODEL = process.env.LEAD_MODEL;
      if (!TASK_MODEL || !LEAD_MODEL) {
        ctx.ui.notify("TASK_MODEL and LEAD_MODEL must both be set.", "error");
        return;
      }
      const sandboxRoot = path.resolve(process.cwd());

      // 1. Spawn delegator in RPC mode with run_deferred_writer + review.
      //    cwd-guard is loaded with PI_SANDBOX_VERBS="" — defense in
      //    depth, registers zero sandbox tools, but every sub-pi spawn
      //    in the project carries the guard regardless of role.
      const delegator = spawn(
        "pi",
        [
          "-e", CWD_GUARD,
          "-e", RUN_DEFERRED_WRITER_TOOL,
          "-e", REVIEW_TOOL,
          "--mode", "rpc",
          "--tools", "run_deferred_writer,review",
          "--no-extensions",
          "--provider", "openrouter",
          "--model", LEAD_MODEL,
          "--no-session",
          "--thinking", "off",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: sandboxRoot,
          env: {
            ...process.env,
            PI_SANDBOX_ROOT: sandboxRoot,
            PI_SANDBOX_VERBS: "",
          },
        },
      );
      const delegatorTimer = setTimeout(() => delegator.kill("SIGKILL"), DELEGATOR_TIMEOUT_MS);

      // 2. Harvest run_deferred_writer and review calls from delegator stdout.
      //    For each run_deferred_writer: dispatch a real drafter child (see
      //    patterns/drafter-with-approval.md's skeleton, but strip the
      //    ctx.ui.confirm step — the reviewer LLM is the gate here).
      //    For each review with verdict="approve": mark the draft promotable.
      //    For each review with verdict="revise": re-dispatch the drafter
      //    with "Revision feedback: ${feedback}" appended to the task.
      // TODO:VALIDATION — cap iterations at MAX_REVISE_ITERATIONS per subtask
      //    and surface accumulated cost from message_end events.

      // 3. Drive the delegator through phases by writing to its stdin:
      //      {"type":"prompt","message":"Goal: <user goal>. Break it into tasks and call run_deferred_writer for each."}\n
      //      {"type":"prompt","message":"Here are the drafts: <...>. Call review for each."}\n
      //      {"type":"prompt","message":"Revised drafts: <...>. Call review again."}\n
      //    (See delegated-writer.ts's phase loop for the full implementation.)

      // 4. After the delegator closes (or final approve verdicts settle),
      //    promote approved drafts via fs.writeFileSync — with sha256
      //    verification, dup-path skip, and byte-length caps — exactly as
      //    in drafter-with-approval.md's promotion block.

      // TODO:AGENT_PROMPT — if the delegator needs task-specific system
      // instructions (planning heuristics, review criteria), inject them
      // on the first stdin prompt rather than hardcoding here.

      clearTimeout(delegatorTimer);
      ctx.ui.notify(`/TODO:CMD_NAME complete.`, "info");
    },
  });
}
```

## Validation checklist

- `-e CWD_GUARD`, `-e RUN_DEFERRED_WRITER_TOOL`, `-e REVIEW_TOOL` on
  the delegator spawn. cwd-guard is loaded as defense-in-depth even
  though the delegator does no fs work — every sub-pi spawn in the
  project carries the guard. `PI_SANDBOX_VERBS=""` in the delegator's
  env makes cwd-guard register zero sandbox tools, so the delegator's
  visible tool surface remains exactly `run_deferred_writer,review`.
- `"--mode", "rpc"` on the delegator (NOT `json`).
- `"--tools", "run_deferred_writer,review"` on the delegator — no
  read or write verbs.
- `"--no-extensions"` and `"--no-session"` on every spawn.
- `PI_SANDBOX_ROOT: sandboxRoot` AND `PI_SANDBOX_VERBS` (possibly
  empty) in every child env.
- Per-drafter spawn follows the `drafter-with-approval` skeleton
  exactly: `-e CWD_GUARD` + `-e STAGE_WRITE_TOOL`,
  `--tools "stage_write,sandbox_ls"`, env contains
  `PI_SANDBOX_ROOT` AND `PI_SANDBOX_VERBS: "sandbox_ls"`, same
  `stdio`, minus `ctx.ui.confirm`.
- `MAX_REVISE_ITERATIONS` cap enforced per subtask.
- `DELEGATOR_TIMEOUT_MS` + `child.kill("SIGKILL")` hard cap on the
  delegator.
- Per-drafter `DRAFTER_TIMEOUT_MS` + SIGKILL.
- Cost tracking accumulates `message.usage.cost.total` from each
  `message_end` event on BOTH the delegator and the drafters.
- NO `ctx.ui.confirm` anywhere — the reviewer LLM is the gate.
- Final promotion uses sha256 verification + exists-check skip
  (see `drafter-with-approval` skeleton).

If ANY of these is unclear from the user's prompt, treat the ask as
a `drafter-with-approval` fit instead (or emit GAP). Orchestrator
is the right tool only when the user explicitly wants multi-task
dispatch plus LLM review.
