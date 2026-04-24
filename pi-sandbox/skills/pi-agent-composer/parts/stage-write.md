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
so the two are loaded together (stage-write does not provide its
own write channel; cwd-guard's `sandbox_write` covers any
non-staged scratch writes the child might also do).

## Required `--tools` allowlist contribution

```
stage_write,ls
```

Add `read` ONLY if the drafter genuinely needs to read existing
files — `read` weakens the "stage_write is the only write channel"
guarantee by letting the drafter echo an existing file's contents
back out. Prefer feeding relevant existing content into the prompt.

Never add `write`, `edit`, or `bash` — they're real write channels
and defeat the stub.

## Parent-side wiring template

- **Event anchor:** `event.type === "tool_execution_start" &&
  event.toolName === "stage_write"`.
- **Args destructuring:** `const { path: stagedPath, content }
  = event.args as { path: string; content: string };`.
- **State shape:** `const staged: Array<{ path: string; content:
  string }> = [];` — push one entry per matched event. Cap at
  `MAX_STAGED` (typ. 64) and bail if exceeded.
- **Finalize behavior:**
  1. Validate every staged path (absolute? `..`? exists already?)
     per rail 5.
  2. **If `review ∉ components`:** call `ctx.ui.confirm` with a
     per-file preview (path + first ~20 lines). On `false`, notify
     "cancelled" and return — leave nothing on disk.
  3. **If `review ∈ components`:** the LLM verdict is the gate;
     skip `ctx.ui.confirm` entirely. The parent receives `approve`
     / `revise` from the review harvest and promotes only
     `approve`d entries.
  4. For each promotable entry: `fs.mkdirSync(path.dirname(dest),
     { recursive: true }); fs.writeFileSync(dest, content);` then
     `fs.readFileSync(dest)` + sha256 verify against staged
     content.
  5. Final `ctx.ui.notify` with the promoted file list and session
     cost.

### Spawn snippet

```ts
const child = spawn(
  "pi",
  [
    "-e", CWD_GUARD,
    "-e", STAGE_WRITE,
    "--tools", "stage_write,ls",
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
    env: { ...process.env, PI_SANDBOX_ROOT: sandboxRoot },
  },
);
```

## Canonical assembled example

`pi-sandbox/.pi/extensions/deferred-writer.ts` wires stage-write +
cwd-guard into a `/deferred-writer <task>` slash command with a
`ctx.ui.confirm` gate. Use it as the reference whenever the
wiring template above leaves something ambiguous.
