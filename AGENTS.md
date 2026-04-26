# AgentFactory

Workspace for building and testing **pi agents** using
[`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono). Pi is
installed as a regular npm dependency so the `pi` CLI is available via
`node_modules/.bin/pi`.

## Launching pi

Pi always runs from `pi-sandbox/` — its extensions, sessions, and scratch
files live there. The `npm run pi` script handles the `cd` for you and
also passes `--no-context-files` so the outer `AGENTS.md`/`CLAUDE.md`
(which are *human* docs about this repo) don't leak into pi's context.

- `npm run pi` — interactive pi session in the sandbox.
- `npm run pi -- -p "..."` — non-interactive. Forward any extra pi
  flags after the `--`.
- `npx pi --help` — full flag reference (`-e` for extensions, `--skill`
  for skills, `-p` for non-interactive, `--mode json` for streaming
  events, `-nc` / `--no-context-files` to suppress AGENTS.md/CLAUDE.md).

Dependencies live in `node_modules/` at the repo root; run `npm install`
after cloning. Invoking pi directly (`npx pi`) from the repo root is not
recommended — it runs outside the sandbox and will pick up the outer
docs as context.

## Model tiers

This repo assumes a three-tier agent architecture. The concrete model IDs live
in [`models.env`](./models.env) and are loaded as environment variables. When
wiring a new agent, match the tier to the job:

| Variable | Role | When to use |
| --- | --- | --- |
| `PLAN_MODEL` | Big Planner / Orchestrator | Whole-picture strategy and subtask decomposition. Runs rarely; needs frontier reasoning and long-context coherence. |
| `LEAD_MODEL` | Team Lead / Task Overseer | Reviews worker output, assigns follow-ups, keeps the plan on track. Runs often; solid reasoning but not frontier. |
| `TASK_MODEL` | Code Rabbit / Worker | Bulk task execution. Runs constantly; optimize for cost-per-token at acceptable quality. |

In addition to the three tiers, `models.env` exposes
`AGENT_BUILDER_TARGETS` — a comma-separated list of models the
composer skill is expected to work well on (each model should
produce a correct, safe agent spec from a short natural-language
prompt). Current targets: **Haiku 4.5** (`anthropic/claude-haiku-4.5`),
**Gemini 3 Flash Preview** (`google/gemini-3-flash-preview`), and
**GLM 5.1** (`z-ai/glm-5.1`). The variable name predates the
removal of the agent-maker harness; the list is now consumed only
as documentation, since no script reads it after that removal.

Source the file before launching pi so the tier vars are in scope:

```sh
set -a; source models.env; set +a
npm run pi -- --model "$TASK_MODEL"    # or $LEAD_MODEL / $PLAN_MODEL
```

`models.env` is committed because the IDs are not secrets. Put API keys in a
gitignored `.env` instead.

## Creating pi agents

Pi ships no sub-agent feature by default. Use pi itself with one of
three bundled skills; they split on "emit YAML vs. compose-from-patterns
vs. author-TS":

- **`pi-agent-composer`** *(forward-looking, YAML)* — emits a
  declarative YAML spec via the `emit_agent_spec` tool. The
  auto-discovered runner (`pi-sandbox/.pi/extensions/yaml-agent-runner.ts`)
  reads `.pi/agents/*.yml` and registers a slash command per spec,
  dispatching each phase via `delegate()`. Covers `single-spawn`,
  `sequential-phases-with-brief`, and `single-spawn-with-dispatch`
  (the dispatcher topology — see "Dispatcher topology" below);
  emits GAP for the RPC delegator-with-LLM-reviewer topology.
  **Primary entry is
  `npm run agent-composer:i`** — an interactive pi session that
  loads the composer skill plus the always-on rails (cwd-guard
  + sandbox-fs) and exposes ONLY
  `sandbox_read,sandbox_ls,sandbox_grep,emit_agent_spec` so the
  model cannot author code, only declare a spec. Every
  `emit_agent_spec` call routes through a `ctx.ui.confirm` dialog
  that previews the YAML byte-for-byte before it lands; on
  denial the LLM is instructed to ask the user (in chat) what
  to revise, then re-emit. The print-mode form
  (`npm run agent-composer -- -p "..."`) ALWAYS cancels — useful
  only for cancel-path smoke testing, since `ctx.ui.confirm`
  returns false unconditionally in print mode. The composer is
  NOT self-hosted via a YAML slash command — one-shot
  invocations from a stock pi session have no chat affordance
  for revising a denied spec, so all composer use flows through
  the chatty interactive entry.
- **`pi-agent-builder`** — from-scratch authorship. Use when the
  composer flagged a gap, or for shapes the composer cannot
  express (custom UI widgets, compaction strategies, event-only
  extensions, context injection, session persistence, pi
  packages, RPC orchestrator). The skill itself lives at
  `pi-sandbox/skills/pi-agent-builder/` and is loaded ad-hoc via
  `pi --skill skills/pi-agent-builder`; there is no longer a
  dedicated npm wrapper or batch harness for it.

The composer is the only agent-creation path with a dedicated npm
script. The agent-maker / run-task / grade-task harness that
previously drove `pi-agent-builder` and `pi-agent-assembler` was
removed; the assembler skill went with it. The builder skill
remains as a reference for ad-hoc TS-authoring sessions.

### Invoking the skill

```sh
# Composer (primary entry — interactive chat session). The composer
# loads its skill plus the always-on rails (cwd-guard + sandbox-fs)
# and exposes `sandbox_read,sandbox_ls,sandbox_grep,emit_agent_spec`.
# Each emit_agent_spec call confirms the YAML with the user before
# writing; on denial the LLM asks (in chat) what to change and
# re-emits. This is the only sanctioned composer entry — there is no
# self-hosted YAML slash command, because one-shot invocations don't
# have a chat affordance for revising a denied spec.
npm run agent-composer:i

# Print-mode form. ALWAYS cancels every emit (ctx.ui.confirm returns
# false unconditionally in print mode). Use only for cancel-path
# smoke testing — useless for the approve path.
npm run agent-composer -- -p "Drafter that stages writes for approval"

# Generic launcher — open an interactive pi session in the sandbox
# so the user can dispatch any YAML-defined agent the composer
# already emitted via its slash command. Run with no args to list
# available agents.
#
# The previous one-shot `npm run agent -- <name> <args>` dispatch
# path was removed: every gate-bearing emitted agent silently
# no-ops in print mode (`ctx.ui.confirm` returns false there).
# Interactive mode is the only sanctioned entry.
npm run agent                                    # list available agents
npm run agent:i                                  # plain pi REPL in sandbox
npm run agent:i -- some-emitted-agent            # REPL with /<slash> hint
```

The npm scripts source `models.env` first, so `$TASK_MODEL` etc.
are already in scope.

Composer output lands at `pi-sandbox/.pi/agents/<name>.yml`. The
runner picks it up on the next pi startup; restart any active
`npm run pi` session to register newly emitted slash commands.

Builder ad-hoc path (no isolation, no tool scoping — exploratory only):

```sh
set -a; source models.env; set +a
npm run pi -- --provider openrouter --model "$LEAD_MODEL" \
  --skill skills/pi-agent-builder \
  -p "Use the pi-agent-builder skill to <describe the agent>."
```

This runs from `pi-sandbox/` cwd so `skills/pi-agent-builder`,
`.pi/extensions/…`, and `@prompt.md` paths resolve.

For prompts with lots of nested quotes, put the prompt in a file under
`pi-sandbox/.pi/scratch/` and pass `@.pi/scratch/prompt.md` — cleaner
than escaping inline `-p "..."`.

### Dispatcher topology (agent-calls-agent + meta-composer)

Composer-emitted agents can themselves dispatch other emitted
agents (or the composer itself) via the `dispatch-agent` component
plus `composition: single-spawn-with-dispatch`. The dispatcher LLM
calls `dispatch_agent({name, args})`; the parent harvests the
intent and runs the named agent through the same `runSpec` path
the user-facing slash invocation uses, threading the outer `ctx`
through so any nested gate (stage_write confirms, emit_agent_spec
confirms) renders in the user's TUI.

Two motivating use cases:

- **Agent-calls-emitted-agent.** Run an orchestrator that fans
  out to several composer-emitted drafters / recon agents. Each
  dispatched agent's gates render for the user as if they had
  invoked it directly.
- **Agent-calls-composer (meta-composer).** Use the special
  `name: "composer"` virtual entry to ask the pi-agent-composer
  skill to design a brand-new sub-agent on demand. The
  composer's YAML confirm dialog renders in the user's TUI; on
  deny, the dispatcher LLM's own chat affordance becomes the
  natural revise loop ("what would you like to change?"). This
  is the cleaner UX answer to "how does the user revise a
  denied composer spec?" — moving the revise loop one level UP
  into the orchestrator's chat instead of relying on
  `agent-composer:i`'s direct chat session.

Author dispatchers via `npm run agent-composer:i` and run them
via `npm run agent:i -- <name>`. Print-mode dispatch always
cancels every gated sub-call (same `ctx.ui.confirm` returns-
false-in-print rule that affects every other gated path), so
dispatchers are interactive-only.

The RPC delegator-with-LLM-reviewer topology (`review` +
`run-deferred-writer`) remains GAP'd — the dispatcher topology
covers fan-out *without* an LLM reviewer; revise loops happen
at the dispatcher LLM's chat layer, not via an in-flight
reviewer. Use `pi-agent-builder` for the RPC reviewer shape.

### Where agent code lives

| Location (from `pi-sandbox/` cwd) | Behavior |
| --- | --- |
| `.pi/extensions/<name>.ts` | Project-local, auto-discovered by pi |
| `.pi/components/<name>.ts` | Curated reusable child-only parts; loaded via `pi -e <abs path>` from a parent extension. NOT auto-discovered by the parent pi session, so safe to register tools that shadow built-ins (e.g. a stub `stage_write` in place of the real `write`). See "Authoring a new component" below for the per-file pattern. |
| `~/.pi/agent/extensions/<name>.ts` | Global, hot-reloadable via `/reload` |
| `pi -e ./path.ts` | One-off test load (not hot-reloadable) |

### Authoring a new component

Components under `pi-sandbox/.pi/components/` are curated, child-side
TS files loaded via `pi -e <abs path>`. Three structural defenses
gate them at spawn assembly:

- **(A) Path allowlist.** Only files whose basename is in the
  `ROLE_COMPONENTS` set (or owned by a `POLICIES` /
  `TOOL_PROVIDERS` registry entry) in
  `pi-sandbox/.pi/lib/component-policy.ts` may be loaded. Adding a
  new component starts with a one-line entry there.
- **(B) Static import scan.** Components must not import `node:fs`,
  `node:child_process`, `node:net`, `node:dns`, `node:http(s)?`,
  `node:worker_threads`, `node:vm`, `node:dgram`, `node:tls`,
  `node:cluster`, or any of their non-`node:`-prefixed aliases.
  The scan runs at spawn assembly and throws on violation.
- **(E) Runtime tool_call auditor.** cwd-guard's child-side
  `pi.on("tool_call")` handler walks every tool's args and
  rejects any absolute-path string that escapes
  `$PI_SANDBOX_ROOT`. Backstops every component, even ones that
  forget to call `validate()` themselves.

**Default pattern: pure stub, parent-side write.** New components
should follow `stage-write.ts`'s shape — register a stub tool that
takes the LLM's intent as args and returns ok; the parent (the
spawning extension) harvests args from the NDJSON event stream and
performs any actual fs / network / state-changing work itself. The
child does not need `node:fs` for this pattern. Look at
`emit-summary.ts`, `review.ts`, `run-deferred-writer.ts` for
reference — all three are pure stubs.

**For LLM-driven fs (read/list/grep/glob/write/edit):** don't
author a custom tool. Request the corresponding `sandbox_*` verb in
your spawn's `--tools` allowlist; `sandbox-fs.ts` is auto-injected
by `delegate()` and the YAML runner whenever any sandbox verb
appears in the spawn's tool tokens.

**If your component genuinely needs `node:fs`** (uncommon — fits
only when you need synchronous fs feedback in the child's
`execute()`, like `emit-agent-spec.ts` writing a YAML spec or
`stage-write.ts` peeking at `existsSync`), follow the privileged
pattern:

1. Add an entry to `PRIVILEGED_IMPORTS` in
   `pi-sandbox/.pi/lib/component-policy.ts` listing exactly the
   `node:*` modules you need. The scan rejects anything not on
   that list.
2. Import `validate` from `./cwd-guard.ts` and call it on every
   absolute path immediately before the `fs.*` call, including
   paths derived from LLM-supplied args via `path.resolve()` /
   `path.join()`. `validate()` does lex+realpath containment
   against `$PI_SANDBOX_ROOT` and throws on escape, so the worst
   case (e.g. `name: "../../etc/x"` or `relPath: "/etc/passwd"`)
   fails closed before any fs syscall.
3. Cite the existing privileged components (`cwd-guard.ts`,
   `sandbox-fs.ts`, `stage-write.ts`, `emit-agent-spec.ts`,
   `dispatch-agent.ts`) in your PR description so the reviewer
   knows what pattern you're matching.

**Parent-side helpers.** A component can also expose a parent-side
`ParentSide<S, R>` for `delegate()` to consume. Parent-side code
runs in the spawning Node process (not the child pi), so it's not
subject to the import scan, but it should still call `validate()`
(exported from `cwd-guard.ts`) before any fs op on an LLM-derived
path. See `stage-write.ts`'s parent-side `finalize` for the
canonical shape.

**What never to do.** Don't import `child_process`, don't open
sockets, don't shell out via `bash`, don't use `process.binding`
or `require()`-from-string to evade the import scan. The scan
doesn't catch all of these (kernel-level escapes are out of scope
until OS sandboxing lands), but the convention is clear and PR
review enforces it.

### Mandatory safety rails for sub-agents

When an extension delegates to a child `pi` process:

- Pass `--no-extensions` to the child — prevents recursive sub-agents.
- Whitelist the child's tools (`--tools <verbs>`) to match its role.
  Drafter children typically get `stage_write,sandbox_ls` (no
  `sandbox_read`); recon children get
  `sandbox_ls,sandbox_grep,sandbox_glob`. Built-in
  `read`/`ls`/`grep`/`glob`/`write`/`edit` are forbidden across the
  project — sandbox-fs's path-validated `sandbox_*` family is the
  only sanctioned fs surface. Omit every verb the role doesn't
  need — `sandbox_read` on a writer leaks the "stub is the only
  write channel" guarantee, and default tool sets invite `bash`
  loops (`bash` is also forbidden). See "Authoring a new component"
  above for the per-file pattern.
- **`delegate()` and the YAML runner auto-inject the rails.**
  cwd-guard (universal) is loaded on every sub-pi spawn from the
  `POLICIES` registry; sandbox-fs (conditional) is loaded with
  exactly the requested verb subset whenever a `sandbox_*` token
  appears in `--tools`, from the `TOOL_PROVIDERS` registry. You do
  NOT list either name in `delegate({ components: [...] })` — the
  injector throws on duplicates. Adding a new universal rail
  (network-guard, syscall-audit) is a one-line registry entry that
  delegate() picks up automatically.
- **Hand-rolled spawns** (the three RPC delegators + drafter spawns
  in `delegated-writer.ts:DelegatorSession`,
  `orchestrator__gemini__task-orchestrator.ts`, and
  `safe-drafter.ts`) are responsible for loading the rails
  themselves. For no-fs roles: `-e cwd-guard.ts`, plus
  `PI_SANDBOX_ROOT` in the child env (no `PI_SANDBOX_VERBS` —
  sandbox-fs not loaded). For fs-using roles: `-e cwd-guard.ts` AND
  `-e sandbox-fs.ts`, plus both env vars. Import the path constants
  via `import { CWD_GUARD_PATH } from "../components/cwd-guard.ts"`
  and `import { SANDBOX_FS_PATH } from "../components/sandbox-fs.ts"`
  rather than recomputing.
- Forward the parent's `AbortSignal` and truncate captured stdout (~20 KB).
- Match the tier to the child's role: `$TASK_MODEL` for workers,
  `$LEAD_MODEL` for reviewers, `$PLAN_MODEL` for orchestration.
- **Direct-launch entry-point scripts** (those that spawn pi
  without going through `delegate()` or the YAML runner — today,
  `scripts/agent-composer.sh`) are subject to the same rails
  contract: built-in fs verbs forbidden in `--tools`, cwd-guard
  always loaded via `-e`, sandbox-fs loaded whenever any
  `sandbox_*` verb appears, `PI_SANDBOX_ROOT` and (when sandbox-fs
  is loaded) `PI_SANDBOX_VERBS` set in the child env. The shared
  helper `scripts/lib/pi-rails.ts` enforces this; entry scripts
  invoke it via `tsx` to validate their `--tools` and to emit the
  `-e` flags + env-var assignments. Tests at
  `scripts/lib/__tests__/pi-rails.test.ts` keep the helper's
  forbidden/sandbox verb sets in lockstep with `delegate.ts`'s
  `FORBIDDEN_TOOLS` and `cwd-guard.ts`'s `ALL_VERBS`.

**cwd-guard caveat — `!cmd` user-bash escapes are NOT policed.**
The cwd-guard auditor hooks `pi.on("tool_call")`, which fires for
LLM-initiated tool calls in any mode (interactive, print, RPC).
User-typed shell commands (the `!cmd` / `!!cmd` interactive
prefix) fire as a separate `user_bash` event and bypass the
auditor. This is by design — the user is driving the shell
directly, not the LLM acting on the user's behalf — but worth
naming so you don't expect the rails to police it.

See `pi-sandbox/skills/pi-agent-builder/references/` for recipe-level detail.

### Worked examples

Two live reference implementations, each illustrating a distinct
pattern. Docs under `pi-sandbox/skills/pi-agent-builder/references/`
cite them by path; do not edit them without updating the references.

- **Single-task drafter** — `pi-sandbox/.pi/extensions/deferred-writer.ts`
  paired with `pi-sandbox/.pi/components/stage-write.ts`. A
  `/deferred-writer <task>` slash command spawns one drafter child
  whose only write channel is a stub `stage_write` tool. Inputs are
  harvested from the parent's NDJSON event stream, buffered in parent
  memory, previewed via `ctx.ui.confirm`, and `fs.writeFileSync`'d
  into `pi-sandbox/` only on approval.
- **Orchestrator-over-extension** — `pi-sandbox/.pi/extensions/delegated-writer.ts`
  paired with `pi-sandbox/.pi/components/run-deferred-writer.ts` and
  `pi-sandbox/.pi/components/review.ts`. A `/delegated-writer <task>`
  slash command spawns one *persistent RPC* delegator LLM with two
  stub tools (`run_deferred_writer` dispatches a drafter; `review`
  approves or revises a draft). The parent harvests both stub calls
  from NDJSON, runs actual drafter children in parallel, feeds each
  produced file back to the delegator for review, and iterates up to
  3 revise rounds. No human confirm — the reviewer LLM is the gate.
  A live dashboard (`ctx.ui.setWidget` + `ctx.ui.setStatus`) tracks
  per-drafter phase + cost; a combined final notify reports promoted
  files + session cost breakdown.

Every always-on rail from
`pi-sandbox/skills/pi-agent-builder/references/defaults.md` is applied
in both.

## Scripted (non-interactive) pi invocations

Gotchas we've hit when calling `pi -p` from scripts:

- **Text mode buffers stdout.** The default `--mode text` emits nothing until
  the run completes, so progress (and hangs) are invisible. Use
  `--mode json` — it streams NDJSON events line by line (`turn_start`,
  `tool_execution_start`/`_end`, `message_update`, `agent_end`, etc.).
- **Idle tools invite exploration loops.** With the default tool set and a
  coding-agent system prompt, many models spontaneously run `bash`/`read`
  even for trivial prompts, burning turns and minutes. Always either
  `--no-tools` (pure completion) or `--tools <allowlist>` sized to the job.
- **`timeout` doesn't reach pi through `npm exec`.** SIGTERM kills the
  wrapper but the grandchild `pi` keeps running. If you need a hard ceiling,
  also kill the surviving `pi` PID explicitly.
- **Slash commands DO execute in `-p` mode.** `pi -p "/cmd args"` routes
  through `_tryExecuteExtensionCommand` before hitting the LLM. Useful
  diagnostic: in `--mode json`, a *registered* command emits only the
  `session` header on stdout (handler fires, no LLM call); an
  *unregistered* `/cmd` produces the full turn-start/message_update/turn_end
  event cascade. Count types to tell which happened without spending tokens.
- **`ctx.ui.notify` is a no-op in print mode** (`runner.js`'s
  `noOpUIContext`). Mid-run progress messages never reach the NDJSON
  stream — grade/monitor harnesses cannot use notify content as evidence
  of anything. Interactive mode is the only place they surface.
- **`ctx.ui.confirm` returns `false` unconditionally in print mode.** An
  approval-gated command called with `-p` will always hit the cancel
  path immediately. Extensions must exit cleanly on that branch (notify
  "cancelled" and return) or the handler errors out and leaks the wiped
  state. This makes `-p '/your-approval-command …'` a cheap behavioral
  smoke test for the cancel path, but useless for testing the approve
  path.
- **No `--model` + no `--provider` silently defaults to
  `openai/gpt-5.1-codex`.** Not openrouter, not any tier var from
  `models.env`. Always pass both flags explicitly in scripted runs; a
  missing `--model` is a silent cost regression into a different
  provider.

Recommended scripted pattern:

```sh
npm run pi -- --mode json --no-tools \
  --provider openrouter --model "$TASK_MODEL" \
  --no-session --no-skills --no-extensions \
  -p "$prompt" \
  | jq -c 'select(.type | IN("tool_execution_start","turn_end","agent_end"))'
```

### RPC mode — persistent single-spawn children

`--mode rpc` keeps one child pi alive across multiple prompts in the
same session (same conversation history, same LLM memory, same
accumulated cost). Protocol is line-delimited JSON on both channels:

- Parent → child on stdin: `{"type":"prompt","message":"…"}\n` per
  turn. More commands exist (`get_session_stats`, etc.); check
  `node_modules/@mariozechner/pi-coding-agent/dist/modes/rpc/…` if you
  need them.
- Child → parent on stdout: the same NDJSON event stream as `--mode
  json` (`turn_start`, `tool_execution_start`/`_end`, `message_update`,
  `message_end`, `agent_end`, …). `message_end` events carry
  `message.usage.cost.total: number` — accumulate across events for
  the session total.

Choose RPC over the one-shot `--mode json -p` pattern when:

- The child needs to see its own previous output across "phases"
  (dispatch → review → revise loop) without re-priming the context.
- You want a single cost meter for the whole session instead of
  summing across respawns.
- The tool surface differs per phase but the *conversation* is one
  continuous thread. RPC can't re-scope `--tools` mid-session, so
  pass the union of tools the session will ever need and narrow
  **by the prompt** that opens each phase.

Reference implementation: `pi-sandbox/.pi/extensions/delegated-writer.ts`
spawns one RPC delegator with `--tools run_deferred_writer,review` and
drives it through dispatch → review → revise phases via three
different prompts on the same stdin.

## Gotchas we've hit (pi API)

Four sharp edges we've paid for in this repo. Each one is enforced in
`pi-agent-builder`'s references but surfaces here so humans reading
`AGENTS.md` hit them before pi does:

- **`StringEnum` is a named export, not a method on `Type`.** `Type.StringEnum(...)`
  throws at runtime. Use `import { StringEnum } from "@mariozechner/pi-ai"`
  and call it directly: `verdict: StringEnum(["approve","revise"] as const, { description: "…" })`.
- **Tool `execute` return MUST include `details`.** Returning only
  `{ content: [...] }` fails TS compile — `AgentToolResult<unknown>`
  requires it. For stubs pass `details: {}`; for real tools echo the
  structured output you'd want a custom renderer to see.
- **`process.env.FOO` type narrowing doesn't survive closures.** After
  `const FOO = process.env.FOO; if (!FOO) return;` the *outer* binding
  is narrowed to `string`, but a nested function (a drafter helper, an
  event handler) loses the narrowing and sees `string | undefined`.
  Either reassign to a typed `const FOO_NARROWED: string = FOO;`, use
  a non-null assertion at the inner use site, or pass `FOO` as a
  parameter into the nested function.
- **Pi's TUI collapses consecutive info-level notifies.** `showStatus`
  (the info-level renderer at `dist/modes/interactive/interactive-mode.js:2375`)
  *replaces* the previous status line in place when two info-level
  `ctx.ui.notify` calls arrive back-to-back, so mid-run progress
  messages silently overwrite one another. Workarounds: combine into
  one multi-line notify, interleave a non-info notify (warning/error)
  between them, or use `ctx.ui.setWidget` for persistent multi-line
  state that should stay on screen.
- **`pi -e <path>` silently ignores default-exported non-function modules.**
  The loader expects `export default function (pi: ExtensionAPI) { … }`.
  A file that does `const tool: Tool = { … }; export default tool;`
  loads without error but registers nothing, so the child LLM has no
  way to call the stub, `tool_execution_start` for its name never
  fires, and a stub-write harness silently collects zero staged
  writes. Always wrap tool definitions in the factory shape, even
  for child-only stub files.

## Gotchas we've hit (harness / multi-run orchestration)

When running pi in a loop (skill evals, regression harness, batch
generation), a separate class of issues surfaces:

- **`npm run pi` re-sources `models.env` on every invocation.** Env-var
  overrides set by the outer caller get clobbered when the script
  re-runs `set -a; source models.env; set +a`. To iterate on a subset
  of `AGENT_BUILDER_TARGETS`, either edit `models.env` directly or
  set the override *after* the source step inside your wrapper.
- **Models write files anywhere they think "the project" lives** (historical).
  A skill run that produced a "correct" extension could still land it in
  `/home/user/AgentFactory/.pi/extensions/` (repo root),
  `/home/user/.pi/agent/extensions/` (global), or
  `pi-sandbox/<stray>.md` (sandbox root) — none of which is the
  canonical `pi-sandbox/.pi/extensions/`. The defense available today
  is the policy/surface split under `pi-sandbox/.pi/components/`:
  `cwd-guard.ts` is the universal cwd policy (auto-injected by
  delegate(); attaches a `pi.on("tool_call")` auditor that blocks
  out-of-cwd path args), and `sandbox-fs.ts` registers the
  path-validated `sandbox_write` / `sandbox_edit` tools when their
  verbs appear in `--tools`. Paired with a `--tools` allowlist that
  excludes the built-in `write` / `edit`, this is the only fs path
  for the LLM. The composer path uses these rails by default;
  `npm run pi` (direct skill invocation) still has the wide tool
  surface — use it only for interactive exploration.
- **Claude Code's `Monitor` tool can't be cancelled programmatically
  in this environment** — the Monitor description mentions `TaskStop`
  but it isn't surfaced as an available tool, so monitors run until
  their `timeout_ms` or their script exits. When the background job
  they're watching finishes via a separate completion notification,
  the monitor keeps running until its own timeout fires and then
  emits a stale `[Monitor timed out]` event. These trailing events
  are cosmetic — ignore them. Mitigations: arm the monitor with a
  `timeout_ms` close to the expected runtime rather than the max
  (keeps stale-event latency low), and don't start a new monitor
  on top of a stale one for an unrelated test.
- **Don't hand Claude Code a plan that says "copy a big file verbatim,
  then edit sections" and expect it to emit the result in a single
  `Write` call.** We hit this with the old bash grader
  `scripts/grade-deferred-writer.sh` (571 lines / 23 KB of escape-heavy
  bash — nested quote regexes, heredocs, `awk -F:` + `printf`-built
  JSON; since deleted). Every attempt crashed
  at the same point: the small rubric committed fine, then the
  grader copy died mid-`Write`. The failure is some mix of
  per-response output-token ceiling, JSON-escape corruption of the
  tool-call argument under length, and plain attention divergence
  on "copy exactly 400 lines, change nothing." The fix is to keep
  the body off the model's output stream entirely: `cp <src> <dst>`
  via Bash, then one `Edit` per swap-map row with
  `old_string`/`new_string` scoped to <30 lines. `sed -i` is **not**
  a substitute — regex-heavy bash fights `sed`'s own quote escaping
  in a different but equally bad way. Treat "re-emit a >~300-line
  transformed copy via a single `Write`" as the anti-pattern and
  always decompose it into `cp` + targeted `Edit`s.
- **Recon behavioral probe historically ran `behavioral=partial` on
  `$TASK_MODEL` (deepseek-v3.2).** The grader looks for a `.md`/`.txt`
  file under `.pi/scratch/` containing the `evidence_anchor` string
  (e.g. `SKILL.md`). Generated recon extensions write that file only
  when their child pi calls the `emit_summary` stub — and deepseek-v3.2
  regularly skipped the stub call on recon prompts, so the parent's
  handler returned via the silent `summaries.length === 0` branch
  (`ctx.ui.notify` is a no-op in print mode, so the failure didn't
  surface in NDJSON). The `seedReconFixture` helper in
  `scripts/grader/lib/probes.ts` is the test-isolation seam; if you
  need to tighten coverage later, options are: (a) use `$LEAD_MODEL`
  for the recon probe's child specifically, (b) log the child's
  stdout to a scratch file so the silent early-exit branches become
  visible, or (c) relax the evidence check.

## Repo layout

- `package.json` — ESM project, pins `@mariozechner/pi-coding-agent`. The
  `pi` script cds into `pi-sandbox/` and passes `--no-context-files`.
- `models.env` — tier → model-ID mapping (see above).
- `AGENTS.md` / `CLAUDE.md` — human docs about this repo. **Not** loaded
  into pi sessions (`npm run pi` passes `-nc`).
- `pi-sandbox/` — pi's cwd. Every pi invocation should run from here so
  auto-discovery stays scoped.
  - `pi-sandbox/.pi/extensions/` — project-local pi extensions
    (auto-discovered when cwd = `pi-sandbox/`, tracked in git).
  - `pi-sandbox/.pi/components/` — curated reusable child-only parts
    loaded into child pi processes via `pi -e <abs path>`, not
    auto-discovered by the parent. Two universal rails (cwd-guard
    + sandbox-fs) plus role stubs (stage-write, emit-summary,
    review, run-deferred-writer, emit-agent-spec, dispatch-agent).
    See `stage-write.ts` for the pure-stub pattern and the
    "Authoring a new component" section above for the full
    privileged-vs-stub guide. Distinct from pi's per-cwd
    `.pi/child-tools/` convention (which a generated extension
    writes to under its own cwd); this directory is the repo's
    *curated* library, structurally enforced by
    `pi-sandbox/.pi/lib/component-policy.ts`.
  - `pi-sandbox/.pi/lib/` — runtime support for the components.
    `delegate.ts` (the parent-side runner shared by extensions),
    `dispatch-spec.ts` (shared per-spec dispatch engine — the
    YAML runner and dispatch-agent's parentSide both consume
    runSpec/validateSpec from here),
    `policies.ts` + `tool-providers.ts` (registries of universal
    + conditional rails), `auto-inject.ts` (the augmentation
    logic the runner calls), `component-policy.ts` (path
    allowlist + import scan).
  - `pi-sandbox/.pi/agents/` — composer-emitted YAML specs
    (`.yml` per agent). Picked up by
    `pi-sandbox/.pi/extensions/yaml-agent-runner.ts` on pi startup,
    which registers one slash command per spec. Tracked in git
    once intentional; `.pi/scratch/` covers throwaway runs.
  - `pi-sandbox/.pi/scratch/` — throwaway prompt files, raw pi output,
    anything you don't want to check in. Gitignored.
  - `pi-sandbox/skills/pi-agent-builder/` — pi skill that teaches pi how
    to author TS extensions from scratch. Reference / ad-hoc only;
    no dedicated runner.
  - `pi-sandbox/skills/pi-agent-composer/` — pi skill that teaches pi
    to emit YAML agent specs via `emit_agent_spec`. Driven by
    `npm run agent-composer`.
- `scripts/grader/` — TypeScript grader for composer-emitted artifacts.
  - `scripts/grader/patterns/` — pattern markdown files (recon,
    drafter-with-approval, …) consumed by `lib/pattern-spec.ts` and
    by the reverse-pipeline's curation enumerator.
  - `scripts/grader/fixtures/` — composer regression task specs.
- `scripts/reverse-pipeline/` — generator that turns curations into
  prompt+test.yaml fixtures. Output lands in
  `scripts/reverse-pipeline/generated/<tag>/test.yaml` (gitignored).
- `scripts/agent-composer.sh`, `scripts/run-agent.sh` — composer
  driver and generic YAML-agent launcher. agent-composer.sh
  enforces the rails contract via `scripts/lib/pi-rails.ts`
  (built-in fs verbs forbidden in `--tools`, cwd-guard +
  sandbox-fs auto-loaded with the right env vars).
- `scripts/lib/pi-rails.ts` — shared rails-contract helper for
  direct-launch entry-point scripts. Exports
  `assertRailsCompatibleTools` + `piRailsExtensionArgs` +
  `piRailsEnv`; CLI subcommands `check | argv | env`. Tests at
  `scripts/lib/__tests__/pi-rails.test.ts`, run via
  `npm run test:rails`.

Additional agent definitions, extensions, skills, or prompt templates can be
added under `pi-sandbox/` and loaded via `-e <path>` / `--skill <path>`.

## Workflow

- **Build pi extensions by having pi build them.** The preferred path is
  `npm run pi -- --skill skills/pi-agent-builder -p "<short description>"`
  (or via `@.pi/scratch/prompt.md` for longer asks). The `pi-agent-builder`
  skill is written for pi to consume, not for Claude or any other harness
  to read on its behalf.
- **Short natural-language prompts are the norm.** If a short prompt
  produces an incorrect or unsafe extension, the fix is to refine the
  skill — add the missing signal to
  `pi-sandbox/skills/pi-agent-builder/references/reading-short-prompts.md`
  or the missing rail to `.../references/defaults.md` — rather than
  padding every prompt with a full technical spec.
- **Scratch artifacts live in `pi-sandbox/.pi/scratch/`** (gitignored).
  Raw pi output, throwaway prompt files, and experiments go there and
  stay out of the tracked tree.

## Conventions

- Develop on the designated feature branch for the current task; do not
  push to other branches without explicit approval.
- Commit messages should explain the *why* concisely.
- Don't commit secrets — `.env`, `.env.local`, and `node_modules/` are already
  ignored.
