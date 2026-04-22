# Default safety rails

Apply every rail in this file to every extension you generate, unless the
user **explicitly** tells you to skip one. Each rail exists because its
absence caused a real failure in a real session.

## For every sub-agent (child `pi` process)

- `--no-extensions` on the child — prevents recursive sub-agents (recursion
  bombs are a standard failure mode; pi has no built-in depth limit).
- Forward the parent's `AbortSignal` into `spawn({ signal })`, *and* add
  `signal?.addEventListener("abort", () => child.kill())` as belt-and-braces —
  Node's `spawn` respects `signal` at start only.
- Truncate captured stdout to ~20 KB in the tool's returned `content`.
  For larger outputs, write the full transcript to a tempfile and return
  the path.
- Set `--model` to a tier-appropriate value: `$TASK_MODEL` for workers,
  `$LEAD_MODEL` for reviewers, `$PLAN_MODEL` for orchestration. Read from
  `process.env` at call time; fall back to a concrete known model ID.
- Pass `--no-session` unless the child's session needs to feed back into
  parent state.

## For every slash command with a side effect

- `ctx.ui.confirm(title, preview)` before the effect fires. `preview` is a
  short readable string (first ~40 lines of whatever is about to change).
  Confirmation without a preview is a rubber stamp.
- Return early on `undefined` or `false` from `confirm`. Don't fall through.
- After the effect, `ctx.ui.notify("<result>", "info")` so the user has a
  receipt.

## For every writer / mutator

- Validate the target path *before* writing: string, non-empty, not
  absolute (unless explicitly allowed), no `..` segments, not already
  existing (unless overwrite is explicit in the prompt).
- Recheck `!fs.existsSync(path)` *immediately* before the write too — the
  file could have appeared during confirmation.
- After writing: verify the file exists AND `sha256(fs.readFileSync(path))`
  equals the hash of what you intended to write. On mismatch, `notify` an
  error — do not silently "succeed".

## For parent `pi` processes the skill itself spawns

(These apply when the *skill* is running pi programmatically — e.g. a
script that calls pi to generate an extension, or an extension that
spawns pi as a sub-agent.)

- `--no-tools` if the child only needs completion, otherwise `--tools
  <allowlist>`. With the default tool set, coding-agent models often run
  `bash`/`read` spontaneously even on trivial prompts, burning turns.
- `--mode json` for any scripted or monitored run — text mode block-buffers
  stdout until the process exits, so mid-run kills yield zero output.
  JSON mode streams one NDJSON event per line (`turn_start`,
  `tool_execution_start`/`_end`, `message_update`, `agent_end`, …).
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
