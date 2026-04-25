# Always-on rails

These twelve rails apply to every composer-generated extension.
Each cites the corresponding section in
`pi-sandbox/skills/pi-agent-builder/references/defaults.md` rather
than re-prosing the rule; the grader (`scripts/grader/graders/composer.ts`)
asserts each one.

## Who owns each rail in the YAML composer

`pi-sandbox/.pi/lib/delegate.ts` — the shared runtime — owns
rails **1, 2, 3, 4, 5, 6, 7, 8, 9, 10, and 12** for every
`single-spawn` and `sequential-phases-with-brief` composition.
The runner extension (`pi-sandbox/.pi/extensions/yaml-agent-runner.ts`)
calls `delegate()` once per phase, so the library enforces the
rail mechanics on the YAML's behalf — no wiring escapes into the
spec file.

`emit_agent_spec` and the runner together own:

- **input validation** — `emit_agent_spec` rejects orphan
  components, missing phase fields, and `review` /
  `run-deferred-writer` declarations (those require the deferred
  RPC topology).
- **template substitution** — the runner substitutes `{args}`,
  `{sandboxRoot}`, and (phase 2 only) `{brief}` before each
  `delegate()` call.
- **brief budget** — the runner aborts if the assembled brief
  exceeds 16 KB before spawning phase 2.

Composer-skill authorship responsibilities collapse to:

- **picking the component set correctly** — steps 1–3 of
  `procedure.md`.
- **writing prompts that hold their own** — the YAML's `prompt:`
  fields are the only thing the model gets to write. Make them
  task-shaped and reference the template variables explicitly.

Rail **11 (dashboard)** does not apply — it is orchestrator-only,
and the orchestrator topology is deferred (composer emits GAP).

The per-rail table below describes the *mechanics* the runtime
enforces; treat it as the library's contract, not your own
checklist. If you find yourself wanting to author TS, stop — you
have no write tool, and the YAML spec is the entire deliverable.

| # | Rail | Cite |
| --- | --- | --- |
| 1 | **Spawn frame.** `spawn("pi", [...args], { stdio: ["ignore", "pipe", "pipe"], cwd, env })` with `--mode {json|rpc}`, `--no-extensions`, `--no-session`, `--thinking off`, `--provider openrouter`, `--model` from `process.env.{TASK,LEAD,PLAN}_MODEL` matched to the role. | `defaults.md#canonical-drafter-spawn`, `#for-every-sub-agent-child-pi-process` |
| 2 | **NDJSON line-parse loop.** `buffer += d.toString(); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) { try { const ev = JSON.parse(line); … } catch {} }`. Never call `JSON.parse(d.toString())` directly — multi-event chunks crash. | `defaults.md#for-every-sub-agent-child-pi-process` |
| 3 | **Hard timeout.** `const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS); child.on("close", () => clearTimeout(timer)); child.on("error", () => clearTimeout(timer));`. SIGTERM is not enough; the LLM call inside pi ignores it. | `defaults.md#for-every-sub-agent-child-pi-process` |
| 4 | **Cost extraction.** Read `event.message.usage.cost.total` on `message_end` events; accumulate into a session total; surface in the final `ctx.ui.notify`. | `defaults.md#cost-tracking-always-on` |
| 5 | **Path validation.** Every harvested path: reject absolute (`path.isAbsolute`), reject `..` segments (`path.normalize` then check `startsWith("..")`), assert `resolved.startsWith(sandboxRoot + path.sep)`, and check `fs.existsSync` for the destination's parent dir. | `defaults.md#for-every-writer-mutator` |
| 6 | **Promotion caps.** `MAX_FILES_PROMOTABLE` (typ. 20) and `MAX_CONTENT_BYTES_PER_FILE` (typ. 256 KB). After write, `fs.readFileSync(dest)` + sha256 + assert against the staged content. `fs.mkdirSync(path.dirname(dest), { recursive: true })` before write. | `defaults.md#deferred-approval-gated-side-effects`, `#in-memory-variant-preferred` |
| 7 | **Output path.** All promoted files go under `.pi/extensions/<name>.ts` (or `.pi/scratch/<name>.md` for `emit-summary` persistence), never the cwd root. Reject any staged path that doesn't start with one of these prefixes. | `defaults.md#for-every-writer-mutator` |
| 8 | **Tool allowlist.** `--tools` is the union of each selected component's `toolsContribution` (see `parts/<name>.md`). For `cwd-guard`, the contribution is whatever subset of `sandbox_read,sandbox_ls,sandbox_grep,sandbox_glob,sandbox_write,sandbox_edit` the role asked for. Never include built-in `read`/`ls`/`grep`/`glob`/`write`/`edit` (forbidden across the project) or `bash` — those defeat every stub in the library. | `defaults.md#tool-allowlist-always-on` |
| 9 | **Sandbox root + verb selection.** `cwd-guard.ts` is loaded on EVERY sub-pi spawn (defense-in-depth). `PI_SANDBOX_ROOT: sandboxRoot` AND `PI_SANDBOX_VERBS: <comma-sep subset, may be empty>` in the child's `env`. For no-fs roles `PI_SANDBOX_VERBS` is `""` and cwd-guard registers zero sandbox tools. The runner sets both automatically when you go through `makeCwdGuard({verbs: [...]})`. Compute `sandboxRoot` from the parent extension's own `import.meta.url`, not from `process.cwd()` or `$HOME`. | `defaults.md#for-every-writer-mutator` |
| 10 | **Confirmation gate.** Required iff `stage-write ∈ components && review ∉ components`: call `ctx.ui.confirm` with a per-draft preview before any parent-side `fs.writeFileSync`. When `review ∈ components`, the LLM verdict is the gate — do NOT also call `ctx.ui.confirm` (double-gating breaks the orchestrator's autonomy). | `defaults.md#deferred-approval-gated-side-effects` |
| 11 | **Dashboard (orchestrator-only).** When the topology is `rpc-delegator-over-concurrent-drafters`, call `ctx.ui.setWidget` + `ctx.ui.setStatus` on every state mutation (drafter spawned, draft staged, review verdict received, promotion done). Guard against absence — `ctx.ui.setWidget?.(…)` so non-TUI runners don't crash. | `defaults.md#ui-dashboards-and-notifies` |
| 12 | **Phase-boundary notifies.** `ctx.ui.notify` once per phase boundary: child spawn, harvest complete, promotion complete (or GAP / cancellation paths). One multi-line message per phase — info-level notifies collapse in the TUI when issued back-to-back. | `defaults.md#ui-dashboards-and-notifies` |

## Why these are the rails

Pattern skeletons in `pi-agent-assembler/patterns/` enforce the
same rails by-copy: each skeleton inlines the spawn frame, the
NDJSON loop, the timeout, etc. The composer can't ship per-shape
skeletons, so this checklist takes their place. `compositions.md`
points at canonical extensions that already implement every rail
(`deferred-writer.ts`, `delegated-writer.ts`); the composer's job
is to verify each rail appears in its output, not to author the
rail's mechanics from primitives.

If a rail is missing, the grader marks it as a P0 wiring failure
and the run does not pass. There is no "it's fine to skip the
timeout for a small task" — every rail prevents a specific failure
mode catalogued in `defaults.md`.
