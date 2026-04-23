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

### Persistent RPC sub-agents (single-spawn across phases)

When one child LLM must run across multiple phases (dispatch → review
→ revise) and *keep its conversation history*, don't respawn. Use
`--mode rpc` instead of `--mode json -p`. Rails:

- `--mode rpc` instead of `-p "<prompt>"`. The prompt arrives via
  stdin as `{"type":"prompt","message":"…"}\n` per turn. Stdout is
  the same NDJSON event stream as `--mode json`.
- **stdin must stay open for the life of the session** (don't
  `stdio: ["ignore", ...]` here — the child needs to read prompts).
  `stdio: ["pipe", "pipe", "pipe"]`.
- Line-buffer stdout yourself. Events arrive as `\n`-delimited JSON;
  split on the last `\n` and keep the trailing partial line as a
  buffer for the next chunk.
- **RPC cannot re-scope `--tools` between phases.** Pass the *union*
  of tools any phase will need (e.g. `--tools run_deferred_writer,review`)
  and narrow per phase via the prompt that opens the phase ("In this
  turn, call run_deferred_writer once per subtask, then reply DONE").
  This is a genuine least-privilege rail — the union stays small and
  excludes every built-in (`bash`/`read`/`grep`/`write`).
- Still pass `--no-extensions --no-session --thinking off` and a
  tier-appropriate `--provider openrouter --model "$LEAD_MODEL"`.
- Still wrap the whole session in a hard timeout (SIGKILL ceiling),
  still forward the parent's `AbortSignal`, still pin `cwd`.
- Accumulate cost from `message_end` events (see *Cost tracking*
  below). In RPC mode you sum across phases; one child, one running
  total.

Reference: `.pi/extensions/delegated-writer.ts`.

### UI: dashboards and notifies

Pi exposes two persistent-UI channels on `ctx.ui` alongside the
ephemeral `notify`:

- `ctx.ui.setWidget(key, lines | undefined)` — renders a multi-line
  block above the editor. Each call with the same `key` replaces the
  previous content. Pass `undefined` to clear.
- `ctx.ui.setStatus(key, text | undefined)` — renders a single-line
  status entry in the bottom status bar. Same key semantics.

Both are fire-and-forget (no await, no return value). Both **may be
absent** on clients other than the interactive TUI (notably the RPC
client), so guard every call: `ctx.ui.setWidget?.(key, lines)` and
wrap in `try { … } catch {}`. Always clear both in `finally`.

Use `setWidget`/`setStatus` for **live progress** that must stay on
screen (per-child phase, verdicts, accumulating cost). Use `notify`
only for (a) terminal errors and (b) a single combined final success
notify on completion — `showStatus` (the info-level `notify` renderer
at `dist/modes/interactive/interactive-mode.js:2375`) *replaces* the
previous status line in place when two info-level notifies fire
back-to-back, so mid-run `notify` calls silently overwrite each
other. Two ways to sidestep the collapse: combine into one multi-line
notify, or interleave a non-info level between them.

### Cost tracking (always on)

This is a rail, not an option. Every extension that spawns one or
more LLM children MUST track and surface cost:

- Accumulate `message.usage.cost.total` from every `message_end`
  event the child emits. Track per tier separately when you have
  multiple (e.g. one delegator total + one aggregated drafter total)
  so the breakdown is legible.
- Surface a **running total in the status bar** while the command
  runs (`ctx.ui.setStatus(DASHBOARD_KEY, \`cost: $\${total.toFixed(4)}\`)`).
  Users watch it climb and kill runaway sessions early.
- Include the total + per-tier breakdown in the **combined final
  success notify** (alongside the list of promoted files).
- On every bail-out path — timeout, max-revisions exceeded, hard
  error, user abort — still emit a `Session cost (no promotion): $X`
  notify before returning. Silent bail-outs hide what was spent.
- A provider that omits the cost field must render as `$0.0000`,
  never throw. Treat `message?.usage?.cost?.total ?? 0` as the
  accumulator step.

### Tool allowlist (always on)

Every child LLM gets the minimum tool surface for its role; "just in
case" is not a reason to add a tool.

- One-shot children: pass `--tools <comma-list>` with exactly the
  verbs the role needs. Examples: drafter → `stage_write,ls,read`;
  reviewer → `review`; dispatcher → `run_deferred_writer`.
- RPC children: see *Persistent RPC sub-agents* above — pass the
  union of per-phase tools and enforce phase narrowing via the
  prompt that opens each phase.
- Built-in tools the role does **not** need (`bash`, `read`, `grep`,
  `write`, `edit`, `glob`, `ls`, `task`) must not appear in the
  spawn command. Default tool sets on coding-agent models cause
  spontaneous `bash`/`read` calls that burn turns.
- If the child needs a stub tool that shadows a built-in (a
  `stage_write` standing in for `write`), load it via `-e <absolute
  path>` *and* pass `--no-extensions` so the only way that tool name
  resolves is to the stub.

This rail pairs with the sandbox rails in *For every writer /
mutator* below — a narrow allowlist is how you prove the child
*can't* write outside the staged channel.

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
  its own file *outside* the auto-discovered extensions path. The
  canonical location is `.pi/child-tools/<n>.ts` under the same
  project-local `.pi/` directory as the parent extension — NOT a global
  path under `$HOME`. The stub file must use the factory shape and
  return `details`:

  ```ts
  // .pi/child-tools/stage-write.ts
  import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
  import { Type } from "typebox";

  export default function (pi: ExtensionAPI) {
    pi.registerTool({
      name: "stage_write",
      label: "Stage Write",
      description: "Draft a file. Content is staged in the parent's memory for user review before being persisted. Use in place of `write`.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative destination path inside the project." }),
        content: Type.String({ description: "Full text content of the file." }),
      }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: `Drafted ${params.path} (${Buffer.byteLength(params.content, "utf8")} bytes). Staged; not yet written.` }],
          details: {},   // REQUIRED — the AgentToolResult type refuses to compile without it
        };
      },
    });
  }
  ```

  **Three traps this block protects against, each of which we have
  paid for in a real run:**
  1. A bare `const stage_write: Tool = { ... }; export default stage_write;`
     loads without error under `pi -e <path>` but registers *nothing* —
     the child LLM then has no `stage_write` tool, `tool_execution_start`
     for the name never fires, and the parent collects zero staged
     writes. The default export MUST be a function.
  2. Dropping `details` (returning just `{ content: [...] }`) fails the
     TS `AgentToolResult` constraint at compile time. For a stub with
     nothing structured to report, `details: {}` is the correct value
     — not `null`, not the param object, not omitted.
  3. Resolving the child-tool path via `process.env.HOME` or a global
     `~/.pi/` prefix ties the parent extension to one user's home
     directory. Use `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "child-tools", "stage-write.ts")`
     inside the parent extension — relative to the parent's own file —
     so the layout ships with the project and works on any machine.
- Spawn the child with `-e <abs path to stub tool> --no-extensions --tools stage_write,ls`.
  The `<abs path to stub tool>` should be computed from the parent
  extension's own location (see the `fileURLToPath(import.meta.url)`
  recipe above), not hardcoded and not derived from `$HOME`.
  The child can walk the sandbox via `ls` on absolute paths under
  `sandboxRoot` to pick destinations, but has no `write` tool — `stage_write`
  is its only channel for producing files. **Do NOT add `read`** to the
  allowlist: the drafter is not meant to be reading existing file contents,
  and every built-in it gets weakens the "stage_write is the only write
  channel" guarantee. If the drafter genuinely needs prior-file context
  to do its job, surface it in the prompt instead — don't hand it `read`.
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
- `registerTool` parameters use TypeBox. **Import from `typebox`**, not
  `@sinclair/typebox` — pi 0.69.0 migrated the first-party packages to
  the new `typebox` 1.x package. The legacy root alias still works for
  back-compat, but `@sinclair/typebox/compiler` is no longer shimmed,
  and new code should depend on `typebox` directly. For enums that must
  work with Google/Gemini providers, use `StringEnum`, not plain
  `Type.String({ enum: [...] })`.
- `registerTool` execute results may return `terminate: true` to skip
  the automatic follow-up LLM turn after the current tool batch (new
  in pi 0.69.0). Use it when the tool call **is** the final answer —
  structured-output tools, `submit_answer`-style end markers, any stub
  whose return value already contains everything the caller needs.
  Every tool result in the batch must be terminating for the hint to
  take effect. Pair it with a `promptGuidelines` entry telling the LLM
  to use the tool as its last action, e.g. `["Use submit_answer as
  your final action. Do not emit another assistant message after
  calling it."]` — without the guideline the model may keep issuing
  more calls, and then `terminate` does nothing. Do NOT use it for
  tools that might run in a loop (a writer called once per file, a
  staging tool where multiple invocations are expected), or the agent
  will stop after one call. See `tool-recipe.md` for the full pattern.
- Tool `content` is what the LLM sees in context; `details` is for
  renderers/your own bookkeeping. Don't stuff the full transcript into
  `content`.
