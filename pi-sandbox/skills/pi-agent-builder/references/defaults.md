# Default safety rails

Apply every rail in this file to every extension you generate, unless the
user **explicitly** tells you to skip one. Each rail exists because its
absence caused a real failure in a real session.

## For every sub-agent (child `pi` process)

- `--no-extensions` on the child — prevents recursive sub-agents (recursion
  bombs are a standard failure mode; pi has no built-in depth limit).
- **`stdio: ["ignore", "pipe", "pipe"]` on `spawn`** — pi reads stdin on
  startup and blocks forever when stdin is a pipe, even with `-p`. Ignoring
  stdin lets pi fall through to the prompt from argv. Without this, every
  child appears to hang at 0% progress.
- **Wrap every `spawn` in a hard timeout.** `setTimeout` + `child.kill("SIGKILL")`
  with a per-phase ceiling (120s is a reasonable default). Without this,
  a single slow or stuck child pi will block the parent's handler
  *indefinitely* — and for slash commands, that freezes the whole pi
  TUI because the handler never returns.
- Catch `child.on("error", …)` and resolve with a clean failure object.
  An uncaught spawn error (e.g., `pi` not on PATH) otherwise rejects the
  promise and surfaces as an unhandled error.
- If an `AbortSignal` is available (tools get one via `execute`; commands
  do not), forward it into `spawn({ signal })` *and* add
  `signal?.addEventListener("abort", () => child.kill())`. The signal
  covers caller-initiated cancel; the timeout above covers runaway children.
- **Pass `{ cwd: <sandboxRoot> }` on `spawn`.** Pin the child's cwd
  explicitly so relative paths in its output resolve where you expect
  (not wherever the parent happens to be). Use `path.resolve(process.cwd())`
  captured once at handler entry.
- `--mode json` on every child you're going to parse programmatically.
  Text mode block-buffers stdout until the process exits; JSON mode
  streams one NDJSON event per line. Parse `message_end` events with
  `role: "assistant"` to get the final answer, and watch
  `tool_execution_start` to relay progress via `ctx.ui.notify`.
- `--tools <allowlist>` matched to the role. Never rely on the default
  tool set — coding-agent models will call `bash`/`read` spontaneously
  on trivial prompts, burning turns and inflating runtime. A planner
  usually only needs `ls`; a writer usually only needs `write`.
- `--thinking off` on worker children unless the task genuinely benefits
  from extended reasoning. Default thinking can add tens of seconds of
  latency for structured-output tasks where the answer is deterministic.
- Truncate captured stdout / stderr to ~20 KB in the tool's returned
  `content`. For larger outputs, write the full transcript to a tempfile
  and return the path.
- Set `--model` to a tier-appropriate value read from `process.env` at
  handler entry: `TASK_MODEL` for workers, `LEAD_MODEL` for reviewers,
  `PLAN_MODEL` for orchestration. Notify an error and return if the env
  var is unset — *do not* silently fall back to a hardcoded model that
  the user didn't pick.
- `--provider openrouter` (or whatever your project standardizes on)
  explicitly on every child. A model ID with a provider prefix like
  `deepseek/deepseek-v3.2` will otherwise route to that provider's
  direct API, which usually has no API key configured and stalls.
- Pass `--no-session` unless the child's session needs to feed back into
  parent state.

## For every slash command

- **Emit a `ctx.ui.notify` at every phase boundary.** Commands have no
  `onUpdate` channel; the TUI looks frozen while the handler awaits a
  subprocess, HTTP call, or any other slow op. At minimum: a `notify`
  immediately on entry describing what you're about to do, and one
  before each subsequent await that takes more than ~1s. If you're
  spawning a child with `--mode json`, relay `tool_execution_start`
  events through `notify` too — users see the work happening live.
- **Validate `args` before doing anything.** Empty or malformed args
  should notify a usage hint and return, not fall through.
- For commands **with a side effect**, also:
  - `ctx.ui.confirm(title, preview)` before the effect fires. `preview`
    is a short readable string (first ~40 lines of whatever is about to
    change, or the full list of paths about to be touched). Confirmation
    without a preview is a rubber stamp.
  - Return early on `undefined` or `false` from `confirm`. Don't fall through.
  - After the effect, `ctx.ui.notify("<result>", "info")` including the
    **absolute path** of anything created. Relative paths leave the user
    hunting.

## For every writer / mutator

- Validate the target path *before* writing:
  - Non-empty string.
  - Not absolute (unless overwrite is explicit in the prompt).
  - No `..` segments when split on `path.sep`.
  - **Resolves inside a pinned sandbox root.** Capture `sandboxRoot =
    path.resolve(process.cwd())` at handler entry; compute
    `absPath = path.resolve(sandboxRoot, fPath)`; reject unless
    `absPath === sandboxRoot || absPath.startsWith(sandboxRoot + path.sep)`.
    This catches escapes that the `..` check misses (symlinks, Windows
    drive letters, absolute paths the planner slipped through).
  - Not already existing (unless overwrite is explicit in the prompt).
- Recheck `!fs.existsSync(absPath)` *immediately* before the write too —
  the file could have appeared during confirmation.
- After writing: verify the file exists AND `sha256(fs.readFileSync(absPath))`
  equals the hash of what you intended to write. On mismatch, `notify`
  an error — do not silently "succeed".
- When instructing a writer sub-agent via a prompt, pass the **absolute**
  approved path ("write to EXACTLY this absolute path: …") so the child
  can't accidentally write somewhere else based on its own notion of cwd.

## Deferred / approval-gated side effects

When the user wants a "try it first, show me, then commit" flow, prefer
**in-memory staging via a custom tool** over a two-agent planner-writer
handshake *or* a filesystem tmpdir. The in-memory variant keeps every
draft in the parent process's heap until approval — process crash leaves
zero artifacts on disk.

### In-memory variant (preferred)

- Write a small "stub" tool (e.g. `stage_write({ path, content })`) in
  its own file *outside* the auto-discovered extensions path (e.g.
  `.pi/child-tools/stage-write.ts`). Its `execute` body is a no-op that
  just returns `{ content: [{ type: "text", text: "Drafted …" }], details: {} }`.
- Spawn the child with `-e <abs path to stub tool> --no-extensions --tools stage_write,ls,read`.
  The child can read the real project (via `ls`/`read` on absolute paths
  under `sandboxRoot`) but has no `write` tool — `stage_write` is its
  only channel for producing files.
- In `--mode json` the child emits `{"type":"tool_execution_start",
  "toolName":"stage_write", "args": {"path": "...", "content": "..."}}`
  for every call. The parent harvests `e.args.path` and `e.args.content`
  from those events and accumulates them in its own memory. Nothing
  touches disk.
- After the child exits, validate each staged entry (type checks on
  path/content, no absolute, no `..`, sandbox-root check, no pre-existing
  destination, byte-size cap per file) and build a preview.
- `ctx.ui.confirm` with absolute destinations + byte counts + sha prefix
  + first N lines of each draft.
- On approval: `fs.writeFileSync(destAbs, content, "utf8")`, re-sha to
  verify, notify. On refusal: notify "Cancelled"; drafts are simply
  unused memory that GC reaps.
- Cap `MAX_FILES_PROMOTABLE` (50 is reasonable) and a per-file
  `MAX_CONTENT_BYTES` (2 MB is reasonable) for blast-radius control.
- **Field name gotcha:** `tool_execution_start` events put the arguments
  at `e.args`, **not** `e.toolCall.input`. Don't assume; inspect a real
  event once before writing the parser.

### Filesystem variant (fallback)

If the agent genuinely needs to read back its own previous drafts during
the session (iteration), in-memory isn't enough without a `stage_read`
companion. Fall back to a tmpdir:

- `fs.mkdtempSync(path.join(os.tmpdir(), "<feature>-"))` at handler
  entry; `fs.rmSync(dir, { recursive: true, force: true })` in a
  `finally` block.
- Spawn the agent child with `cwd: stagingDir` and the real `write`
  tool. Relative writes land in staging; absolute writes bypass and
  won't be promoted.
- After the child exits, walk `stagingDir` recursively, sandbox-check
  each relative path against `sandboxRoot`, preview, promote on
  approval via `fs.copyFileSync`.

Prefer the in-memory variant unless you have a concrete reason to spill
to disk.

## Structured output between parent and sub-agent

- **Avoid `<`/`>`-delimited tags** for the payload (`<plan>…</plan>`, etc.).
  Renderers, HTML-escaping middleware, and even some TUI layers strip or
  mangle angle brackets — we've seen the opening `<` silently disappear,
  breaking parent-side regex matches. Use distinctive ASCII fences like
  `===PLAN===` … `===ENDPLAN===` (or triple-backtick fenced JSON) instead.
- Put structured fields inside JSON so you can parse once. Ask the
  sub-agent to escape newlines as `\n` in string fields.

## For parent `pi` processes the skill itself spawns

(These apply when the *skill* is running pi programmatically — e.g. a
script that calls pi to generate an extension.)

- `--no-tools` if the child only needs completion, otherwise
  `--tools <allowlist>`. With the default tool set, coding-agent models
  often run `bash`/`read` spontaneously even on trivial prompts.
- `--mode json` for any scripted or monitored run — text mode buffers
  stdout until the process exits, so mid-run kills yield zero output.
- `@path/to/prompt.md` instead of `-p "..."` for any prompt with nested
  quotes. Shell-escaping long prompts with backticks and `${...}` is a
  reliable source of silent breakage.

## Types and APIs that trip people up

- `ctx.ui.notify(message, level)` — level is `"info" | "warning" | "error"`.
  Not `"warn"`. Not `"success"`. Generated code that uses either will
  fail to type-check.
- `registerTool` parameters use TypeBox. For enums that must work with
  Google/Gemini providers, use `StringEnum`, not plain
  `Type.String({ enum: [...] })`.
- Tool `content` is what the LLM sees in context; `details` is for
  renderers/your own bookkeeping. Don't stuff the full transcript into
  `content`.
