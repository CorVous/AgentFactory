# Component: `stage-write.ts`

**Location:** `pi-sandbox/.pi/components/stage-write.ts`

## What it does

Pi extension that registers a **stub** tool `stage_write({path,
content})`. The tool's `execute` is a no-op — it returns a confirm
message but does NOT touch disk. The parent harvests each
`tool_execution_start` event for `stage_write` from the child's
NDJSON stdout (`--mode json`) to recover `{path, content}`.

This means drafts live purely in the parent's heap until the parent
decides to promote them. A child crash, a timeout, or a rejected
approval leaves zero files on disk.

## When to use

- The child should draft files the parent previews and approves
  before anything hits disk.
- Pair with `review` when an LLM (not a human) decides
  approve/revise; pair with neither when the parent uses
  `ctx.ui.confirm`.

## When NOT to use

- The child is trusted to write directly (use `cwd-guard`'s
  `sandbox_write` instead). Staging + promotion adds an approval
  gate that's the wrong shape for batch / scripted runs.

## Load mechanism

```ts
const STAGE_WRITE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "stage-write.ts",
);
```

Pass `-e <STAGE_WRITE>` to the child. Pair with `-e <CWD_GUARD>`
configured with read-only verbs (e.g.
`makeCwdGuard({verbs: ["sandbox_ls"]})`) so the drafter has a
read surface but no real write tool — `stage_write` becomes the
only path-to-disk by construction.

## Required `--tools` allowlist contribution

```
stage_write,sandbox_ls
```

Add `sandbox_read` ONLY if the drafter genuinely needs to read
existing files — `sandbox_read` weakens the "stage_write is the
only write channel" guarantee by letting the drafter echo an
existing file's contents back out. Prefer feeding relevant
existing content into the prompt.

Never add built-in `read`/`ls`/`grep`/`glob`/`write`/`edit`
(forbidden), `bash`, or the cwd-guard write verbs
`sandbox_write`/`sandbox_edit` — they're real write channels and
defeat the stub.

## Parent-side wiring

Adds `stage-write.parentSide` to the `delegate()` call's
`components` array. `delegate()` unions `parentSide.tools`
(contributes `stage_write`) + `parentSide.spawnArgs`
(contributes `-e <stage-write.ts>`) into the child's argv, then
dispatches `tool_execution_start` events for `stage_write` through
`parentSide.harvest`. `parentSide.finalize` validates each
`{path, content}` against the sandbox root + size caps and
returns `StagedWritePlan[]`. `delegate()` itself runs the
rails.md §10 gate: when `review ∉ components` it calls
`ctx.ui.confirm` with a per-file preview and `fs.writeFileSync`s
approved plans with sha256 post-write verify; when `review ∈
components` it returns plans unpromoted for the caller to
reconcile against review verdicts.

```ts
import { parentSide as STAGE_WRITE } from "../components/stage-write.ts";
import { delegate } from "../lib/delegate.ts";

await delegate(ctx, {
  components: [CWD_GUARD, STAGE_WRITE],
  prompt,
});
```

See `_parent-side.ts` for the exact `ParentSide` shape.

## Canonical assembled example

`pi-sandbox/.pi/extensions/deferred-writer.ts` — a 41-line thin
agent that wires cwd-guard + stage-write through a single
`delegate()` call.
