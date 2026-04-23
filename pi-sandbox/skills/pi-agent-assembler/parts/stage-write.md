# Part: `stage-write.ts`

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

- **drafter-with-approval pattern:** user wants to preview
  drafts before anything is written.
- **orchestrator pattern:** each drafter child stages writes so
  the reviewer LLM can decide approve/revise before the parent
  promotes.

## When NOT to use

- `confined-drafter` pattern: the child is trusted to write
  directly (via cwd-guard's `sandbox_write`). Staging + promotion
  adds a user-approval gate that's the wrong shape for batch /
  scripted runs.

## Load mechanism

```ts
const STAGE_WRITE_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "stage-write.ts",
);
```

Pass `-e <STAGE_WRITE_TOOL>` to the child. Pair with
`-e <CWD_GUARD>` so the two are loaded together.

## Required `--tools` allowlist

```
stage_write,ls
```

Add `read` ONLY if the drafter genuinely needs to read existing
files — `read` weakens the "stage_write is the only write channel"
guarantee by letting the drafter echo an existing file's contents
back out. Prefer feeding relevant existing content into the prompt.

Never add `write`, `edit`, or `bash` — they're real write channels
and defeat the stub.

## Harvesting in the parent

The child speaks NDJSON on stdout (`--mode json`). Each time the
LLM calls `stage_write`, the parent sees:

```json
{"type":"tool_execution_start","toolName":"stage_write","args":{"path":"…","content":"…"}}
```

Accumulate `{path, content}` into an array. After the child closes,
validate each draft (path is relative, no `..`, dest doesn't exist,
content byte-length cap) before offering them via `ctx.ui.confirm`.

## Spawn snippet

```ts
const child = spawn(
  "pi",
  [
    "-e", CWD_GUARD,
    "-e", STAGE_WRITE_TOOL,
    "--tools", "stage_write,ls",
    "--no-extensions",
    "--mode", "json",
    "--provider", "openrouter",
    "--model", MODEL,
    "--no-session",
    "-p", agentPrompt,
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: sandboxRoot,
    env: { ...process.env, PI_SANDBOX_ROOT: sandboxRoot },
  },
);
```

## Canonical assembled example

`pi-sandbox/.pi/extensions/deferred-writer.ts` wires stage-write +
cwd-guard into a `/deferred-writer <task>` slash command with a
`ctx.ui.confirm` gate. Use it as the reference whenever
`patterns/drafter-with-approval.md`'s skeleton leaves something
ambiguous.
