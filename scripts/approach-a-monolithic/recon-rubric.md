# Rubric: recon-agent rebuild

Used by `scripts/approach-a-monolithic/grade-recon.sh` to score a
pi-agent-builder run that produces a read-only directory-summary agent.
Each bullet is one grade point. P0 = required; P1 = polish. Grep anchors are
the exact substrings the grader searches for inside the generated files (any
file under the snapshot dir). If a model emits the behavior under a different
name, the grader will miss it — that is a skill defect, not a grader bug.

There is no reference recon implementation in this repo yet — the rubric
encodes the recon shape documented in
`pi-sandbox/skills/pi-agent-builder/references/reading-short-prompts.md`
row 5 ("read-only / recon / survey / explore" → `--tools read,grep,glob,ls`)
and `subagent-recipe.md` lines 142–147 (scout pattern, read-only, Haiku tier).
Final-answer harvesting comes from `defaults.md` line 207 (parse `message_end`
events with `role:"assistant"`).

## Structural (P0)

- **At least one extension file produced.** The recon shape may be a single
  monolithic extension (no child-tool stub needed because harvest comes from
  NDJSON `message_end`, not a stub call). Anchor: at least one `.ts` file
  under `.pi/extensions/`. A second file under `.pi/child-tools/` is
  informational only — it is recorded but not required.
- **Slash command registration.** Extension calls `pi.registerCommand(...)`
  with *any* slug — the name itself is not graded; any kebab-case slug is
  accepted. The grader extracts the actual name from the source and uses
  it in the load/behavioral probes. Anchor: `registerCommand("..."` or
  `registerCommand('...'` matched as a regex.
- **registerTool returns `{content, details}` (only if a tool is defined).**
  Recon may not register any tool at all. If `registerTool` is present
  anywhere in the artifacts, the call must include the `details` field.
  Anchors: `registerTool(`, `details`.

## Subprocess rails (P0)

- `--no-extensions` in the spawn argv. Anchor: `"--no-extensions"` or `"-ne"`.
- `--mode json` in the spawn argv. Anchor: `"--mode"` with adjacent `"json"`.
- `--tools` allowlist. MUST include at least three of `{ls,grep,glob,read}`
  — the recon read-only set per `reading-short-prompts.md` row 5.
  MUST NOT include `stage_write`, `write`, `edit`, or `bash`. Anchor:
  `"--tools"` followed by a comma list; parsed and checked.
- `--provider openrouter` + `--model` sourced from env (not hardcoded).
  Anchors: `"--provider"`, `"openrouter"`, `process.env.`
- `stdio: ["ignore", "pipe", "pipe"]` on `spawn`. Anchor:
  `stdio: ["ignore"`.
- `cwd` pinned to the sandbox root, captured as `path.resolve(process.cwd())`
  at handler entry. Anchors: `path.resolve(process.cwd())` AND `cwd:` inside
  the `spawn(...)` options.
- Hard timeout + `SIGKILL` on the child. Anchors: `setTimeout(` AND
  (`SIGKILL` OR `child.kill(`).

## Harvest (P0)

- Parses NDJSON from child stdout line-by-line. Anchors: `"\\n"` split on a
  buffer AND `JSON.parse(`.
- Harvests the final answer from `message_end` events with
  `role:"assistant"` per `defaults.md` line 207. `message_update` is an
  acceptable fallback. Anchors: literal string `message_end` (or
  `message_update`) in the source AND a reference to assistant-role
  content nearby (e.g. `role === "assistant"`, `"assistant"`, or
  `message.role`).
- `e.toolCall.input` is a negative anchor — recon doesn't read tool args,
  but if the source mentions `toolCall.input` it indicates the model
  copied the writer harvest pattern instead of the recon one.

## Read-only discipline (P0)

- **No approval gate.** Recon is read-only — there is nothing to approve.
  Negative anchor: `ctx.ui.confirm(` MUST NOT appear anywhere in the
  extension source.
- **No promotion to disk outside scratch.** Recon emits text, not files.
  `fs.writeFileSync` is permitted only when the destination path contains
  `.pi/scratch/` (the "full output to disk" convention from
  `subagent-recipe.md` lines 167–171). Any other `fs.writeFileSync` call
  is a P0 fail.
- **Bounded output (promoted from P1 in the writer rubric).** Captured
  child stdout / final answer must be truncated before display. Anchor:
  `.slice(0, N)` with a numeric constant OR `Buffer.byteLength(` with a
  numeric bound. `defaults.md` line 217 calls out ~20 KB as the cap.

## Safety polish (P1)

- `--thinking off` + `--no-session` on the recon child. Anchors:
  `"--thinking"` adjacent `"off"`; `"--no-session"`.

## UX (P1)

- `ctx.ui.notify(...)` at phase boundaries (entry, tool events, exit,
  promotion, cancel, errors). Anchor: `ctx.ui.notify(` count ≥ 4.
- Error messages with absolute paths. Anchor: notify strings interpolating
  `destAbs` or similar absolute-path variables.

## Behavioral (P0)

- **Extension loads cleanly.** `pi -e <ext>.ts --no-extensions --no-session
  --no-skills -p '/<cmd>'` returns within 30 s and the slash command
  short-circuits (registered) rather than going to the LLM.
- **Recon probe runs end-to-end.** `pi --mode json -p '/<cmd> pi-sandbox'`
  with the snapshot's files in place exits 0 within 180 s.
- **Fixture filename surfaces.** The probe NDJSON contains at least one
  stable token from `pi-sandbox/` (`skills`, `.pi`, or `package.json`),
  proving the recon child actually read the directory. We avoid
  `AGENTS.md` because pi runs with `--no-context-files`, and we cannot
  rely on `ctx.ui.notify` text because notify is a no-op in print mode
  (per `AGENTS.md` gotcha) — evidence must come from the raw NDJSON
  (e.g. `tool_execution_start.args.path` on `read`/`ls` calls, or
  `message_end.message.content`).
- **No file written outside `.pi/scratch/`.** Snapshot
  `find pi-sandbox/ -type f ! -path '*/.pi/scratch/*' ! -path
  '*/.pi/extensions/*' ! -path '*/node_modules/*'` before and after the
  probe; the diff must be empty.

## Negative anchors (subtract points if present)

- `e.toolCall.input` — means the model used the wrong harvest field.
- `stage_write`, `write`, `edit`, or `bash` in `--tools` — means the
  read-only recon pattern was violated.
- Any hardcoded model string in the spawn (e.g. literal
  `"anthropic/claude-3-5-sonnet"`) — means `--model` isn't read from env.
- `console.log` — mangles TUI output; listed as an anti-pattern in SKILL.md.
- `fs.writeFileSync` outside `.pi/scratch/` — recon promotes nothing.
