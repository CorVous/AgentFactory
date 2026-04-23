# Rubric: `/deferred-writer` rebuild

Used by `scripts/grade-deferred-writer.sh` to score a pi-agent-builder run.
Each bullet is one grade point. P0 = required; P1 = polish. Grep anchors are
the exact substrings the grader searches for inside the generated files (any
file under the snapshot dir). If a model emits the behavior under a different
name, the grader will miss it — that is a skill defect, not a grader bug.

The reference implementation lives at
`pi-sandbox/.pi/extensions/deferred-writer.ts` +
`pi-sandbox/.pi/components/stage-write.ts` (not present during grading; the
test wipes them).

## Structural (P0)

- **Two files produced.** A command-registering extension and a child-tool
  file. The child-tool must live outside the auto-discovered `extensions/`
  dir (`child-tools/` is the canonical location). Anchors: exactly one file
  contains `registerCommand`; exactly one file contains `registerTool`; the
  registerTool file path does NOT contain `/extensions/`.
- **Slash command registration.** Extension calls `pi.registerCommand(...)`
  with *any* name — the slug itself is not graded. The grader extracts
  the actual name from the source and uses it in the load/behavioral
  probes. Anchor: `registerCommand("..."` or `registerCommand('...'`
  matched as a regex.
- **Stub tool shape.** Child-tool file registers `stage_write` with a
  `{ path, content }` TypeBox schema and returns `{ content: [...], details: ... }`
  — the `details` field must be present (even if `{}`). Anchors: `"stage_write"`,
  `Type.Object`, `content:`, `details:`.

## Subprocess rails (P0)

- `--no-extensions` in the spawn argv. Anchor: `"--no-extensions"` or `"-ne"`.
- `--mode json` in the spawn argv. Anchor: `"--mode"` with adjacent `"json"`.
- `--tools` allowlist. MUST include `stage_write`. SHOULD include `ls`.
  MUST NOT include `read`, `write`, `edit`, `bash`, `grep`, or `glob`.
  Anchor: `"--tools"` followed by a comma list; parsed and checked.
- `--provider openrouter` + `--model` sourced from env (not hardcoded).
  Anchors: `"--provider"`, `"openrouter"`, `process.env.`
- `stdio: ["ignore", "pipe", "pipe"]` on `spawn`. Anchor:
  `stdio: ["ignore"`.
- `cwd` pinned to the sandbox root, captured as `path.resolve(process.cwd())`
  at handler entry. Anchors: `path.resolve(process.cwd())` AND `cwd:` inside
  the `spawn(...)` options.
- Hard timeout + `SIGKILL` on the child. Anchors: `setTimeout(` AND
  (`SIGKILL` OR `child.kill(`).

## Harvest + validate (P0)

- Parses NDJSON from child stdout line-by-line. Anchors: `"\\n"` split on a
  buffer AND `JSON.parse(` AND `tool_execution_start`.
- Reads staged writes from `e.args.path` + `e.args.content` (NOT
  `e.toolCall.input`). Anchors: `args.path` or `args["path"]`; the literal
  string `toolCall.input` is a negative anchor (its presence is a defect
  the skill's "Field name gotcha" is supposed to prevent).
- Holds writes in memory before any disk write. Anchors: an array named
  something like `staged`/`drafts`/`plans` accumulated *before* any
  `fs.writeFileSync` appears textually later in the file (grader checks
  relative positions).
- Validates path: non-empty string, not absolute, no `..` segments,
  resolves inside sandbox root, not pre-existing. Anchors: `path.isAbsolute`,
  `".."` (as a literal), `fs.existsSync`, `sandboxRoot + path.sep` (or
  equivalent `startsWith` sandbox check).

## Approval + promote (P0)

- `ctx.ui.confirm(...)` with a preview string (title and body). Anchor:
  `ctx.ui.confirm(`.
- Early return on falsy confirm result (notify "cancelled" or similar, then
  return). Anchor: a branch that checks the return value of `confirm` and
  returns without calling `fs.writeFileSync`.
- Promotion path: `fs.mkdirSync(..., { recursive: true })` +
  `fs.writeFileSync(...)`. Anchors: `fs.mkdirSync(` with `recursive: true`;
  `fs.writeFileSync(`.

## Safety polish (P1)

- Truncation on notify (bounded-length summaries). Anchor: a string-length
  check ~200–600 chars, or `.slice(0,` with a numeric constant.
- Post-write sha256 verify OR a re-check of `fs.existsSync(destAbs)`
  immediately before the write. Anchors: `createHash("sha256")` or a second
  `fs.existsSync(` call inside the promotion loop.
- `--thinking off` + `--no-session` on the drafter child. Anchors:
  `"--thinking"` adjacent `"off"`; `"--no-session"`.
- File-count and byte-size caps. Anchors: two numeric constants used as
  bounds, e.g. `MAX_FILES_PROMOTABLE` and `MAX_CONTENT_BYTES` or ad-hoc
  numbers compared in `.length` / `Buffer.byteLength` checks.

## UX (P1)

- `ctx.ui.notify(...)` at phase boundaries (entry, tool events, exit,
  promotion, cancel, errors). Anchor: `ctx.ui.notify(` count ≥ 4.
- Error messages with absolute paths. Anchor: notify strings interpolating
  `destAbs` or similar absolute-path variables.

## Behavioral (P0)

- **Extension loads cleanly.** `pi -e <ext>.ts --no-extensions --no-session
  --no-skills -p '/help'` returns within 30 s and includes the registered
  command's name in its output.
- **Slash command accepted.** `pi --mode json -p '/deferred-writer …'` with
  the snapshot's files in place emits at least one NDJSON event for the
  child pi the extension spawns (anything that proves the child was
  actually launched, e.g. a `tool_execution_start` from inside the child or
  a notify relaying a child event).
- **Gate reached without hang.** Same invocation returns within 180 s and
  the process exits 0 (`ctx.ui.confirm` returns false in print mode; the
  extension should treat that as cancel and exit cleanly — no hang, no
  crash, no stray `fs.writeFileSync`).

## Negative anchors (subtract points if present)

- `e.toolCall.input` — means the model used the wrong harvest field.
- Real `write` in `--tools` — means the stub-write pattern was skipped.
- Any hardcoded model string in the spawn (e.g. literal
  `"anthropic/claude-3-5-sonnet"`) — means `--model` isn't read from env.
- `console.log` — mangles TUI output; listed as an anti-pattern in SKILL.md.
