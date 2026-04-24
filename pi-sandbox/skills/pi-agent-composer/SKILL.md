---
name: pi-agent-composer
description: Composes pi agents by emitting a YAML spec (components + per-phase prompts) via the `emit_agent_spec` tool. Use this skill when the user wants to compose a pi-coding-agent extension parts-first — pick whichever components the ask requires and declare them with one of two composition topologies (single-spawn, sequential-phases-with-brief). Trigger on phrases like "compose pi agent", "parts-first", "component-driven", "pi extension that uses cwd-guard / stage-write / emit-summary", or any ask of the form "build a pi agent that uses X". This skill does NOT author code — it emits a YAML spec the auto-discovered runner extension turns into a slash command. Orchestrator topology (RPC delegator + review + run-deferred-writer) is deferred — emit GAP for those asks. If the ask doesn't decompose into the runnable components, STOP and emit a GAP message so the user can fall back to `pi-agent-builder`.
---

# Pi Agent Composer

This skill composes agents by **picking components and emitting a
YAML spec** via the `emit_agent_spec` tool. The runner extension
(`pi-sandbox/.pi/extensions/yaml-agent-runner.ts`, auto-discovered)
reads the YAML and registers a slash command that wires the
declared components via `delegate()`.

If the user's request cannot be expressed in terms of the runnable
components and topologies, the skill **stops and emits a GAP
message**. The gap message is the whole point: when the library
can't cover a shape, you want that known rather than a
confabulated agent.

## Cardinal rules

1. **Compose, don't author.** The components in
   `pi-sandbox/.pi/components/` are the vocabulary. Do not invent
   new child-tools, new stub shapes, or new NDJSON harvesters
   inside this skill. You also cannot author TypeScript — your
   tool allowlist exposes `emit_agent_spec` plus read verbs only.
2. **`cwd-guard` on every write-capable phase.** Every phase whose
   `components` array includes a write-capable part (`stage-write`,
   or any future direct-write component) MUST also include
   `cwd-guard`. The runner pins `PI_SANDBOX_ROOT` automatically via
   `cwd-guard`'s `parentSide.env`. The sole exception is a
   read-only phase whose only output channel is `emit_summary`.
3. **Output via `emit_agent_spec` only.** The tool writes
   `.pi/agents/<name>.yml`; the runner picks it up on the next pi
   startup. You cannot write `.ts`, `.yml`, or any other file
   directly — you have no `write` / `edit` / `sandbox_write`
   tools. A run that finishes without calling `emit_agent_spec`
   produced nothing.

## Parts catalog

All components live in `pi-sandbox/.pi/components/<name>.ts` and are
loaded into child pi processes via `pi -e <abs path>`. Per-component
detail in `parts/<name>.md` (each carries a "Parent-side wiring
template" the parent extension copy-adapts).

| Component | Role | When to use |
| --- | --- | --- |
| `cwd-guard.ts` | Sandbox for child writes | **REQUIRED on every write-capable sub-pi spawn.** Registers `sandbox_write` + `sandbox_edit`; both reject paths outside `$PI_SANDBOX_ROOT`. Replaces built-in `write` / `edit`. Skip only when the child is read-only + `emit_summary`. |
| `stage-write.ts` | Stub drafter channel | The child should draft files the *parent previews and approves* before anything hits disk. Child calls `stage_write({path, content})`; parent harvests from NDJSON `tool_execution_start` events and `fs.writeFileSync`s only on user approval (or LLM verdict, when paired with `review`). |
| `emit-summary.ts` | Stub structured-output channel | The child should return one or more *named summaries* instead of free-form assistant text. Child calls `emit_summary({title, body})`; parent harvests from NDJSON, caps byte-length per body, and persists to `.pi/scratch/<title>.md` or assembles into a brief for a follow-on phase. |
| `review.ts` | Stub reviewer verdict | A reviewer LLM renders `approve`/`revise` on staged drafts. Parent harvests verdicts; `approve` ⇒ promote, `revise` ⇒ re-dispatch the drafter with the feedback string. When `review` is in the component set, the LLM is the gate — no `ctx.ui.confirm` fires. |
| `run-deferred-writer.ts` | Stub dispatch verb | A delegator LLM dispatches one drafter per call. Parent harvests `{task}` strings and runs drafter children in parallel via `Promise.all`. Pair with `review.ts` inside an RPC delegator session. |

## Output channel

The composer's only write tool is `emit_agent_spec` (loaded into
the parent session via `pi -e .pi/components/emit-agent-spec.ts`).
It validates the spec against composition rules and writes
`.pi/agents/<name>.yml`. Detail in `parts/emit-agent-spec.md`.

## Compositions catalog

Two runnable topologies plus one deferred. Pick one based on the
component set; full detail in `compositions.md`.

| Topology | When | What the runner does |
| --- | --- | --- |
| `single-spawn` | One child, one phase. Covers recon-style, confined-drafter, and drafter-with-approval shapes. | One `delegate()` call. Reference: `pi-sandbox/.pi/extensions/deferred-writer.ts` (41-line thin agent over `delegate()`). |
| `sequential-phases-with-brief` | Two phases run serially; the runner assembles a brief from phase 1's `emit_summary` output and substitutes it into phase 2's prompt as `{brief}`. | Two `delegate()` calls bracketing brief assembly. |
| `rpc-delegator-over-concurrent-drafters` | Persistent RPC delegator LLM dispatches drafters via `run_deferred_writer` and reviews their drafts via `review`. | **Deferred — emit GAP.** `delegate()` is single-spawn json-mode only. Reference for hand-authored RPC: `pi-sandbox/.pi/extensions/delegated-writer.ts`. Use `pi-agent-builder`. |

## Always-on rails

Every generated extension applies the rails in `rails.md`. Each
rail cites a section in
`pi-sandbox/skills/pi-agent-builder/references/defaults.md`; treat
the rails file as the authoritative checklist.

## Naming conventions

Component names encode intent. Pick the bucket first; name the tool
second. If no bucket fits, raise it — the library's coherence is
worth the pause.

| Prefix / name | Semantics | Examples |
| --- | --- | --- |
| `stage_*` | Child proposes a side effect; parent holds the commit. The stub returns immediately; the parent decides later whether to persist. | `stage_write`. Future candidates: `stage_exec`, `stage_http_call`. |
| `emit_*` | Structured-output harvest; no side effect deferred. The parent receives a named piece of structured text to display / persist / forward. | `emit_summary`. Future candidates: `emit_finding`, `emit_metric`. |
| role name | Purpose-specific stub. Used when no prefix family fits, typically because the tool is single-use inside one composition. | `review`, `run_deferred_writer`. Future candidate: `ask_user`. |

## Anti-patterns

- **Inventing a new component in a user session.** The library is
  closed; if a new child-tool shape is needed, that's a GAP, not
  an opportunity to improvise.
- **Trying to write TypeScript.** You have no `write` / `edit` /
  `sandbox_write` tools. The only way to commit a result is
  `emit_agent_spec`. A finished session that didn't call it
  produced nothing.
- **Skipping cwd-guard on a write-capable phase.** Non-negotiable
  on every phase whose components include `stage-write` or any
  future direct-write part. The one exception is a read-only
  phase whose only output channel is `emit_summary`.
- **Declaring `review` or `run-deferred-writer` in a phase.**
  `emit_agent_spec` rejects these and the runner refuses to
  register the resulting spec. The orchestrator topology lives in
  `pi-agent-builder`'s scope.
- **Skipping the `rails.md` checklist.** Rails encode the always-on
  defaults from `pi-agent-builder/references/defaults.md`. Drift
  here re-introduces bugs the components were written to prevent.

## When to fall back to pi-agent-builder

Load the `pi-agent-builder` skill instead when:

- The user's request can't be decomposed into the known components
  (the GAP message tells you this).
- The user wants a non-sub-agent extension (a custom-UI widget, a
  compaction strategy, an event-handler-only extension, a context
  injector, session-persistence work, a pi package).
- A composition *almost* matches but the user needs a variant that
  would require a new kind of stub or a new NDJSON event type.
  Authoring from primitives is pi-agent-builder's job.

`pi-agent-builder` carries the API-surface references
(`tool-recipe.md`, `events-recipe.md`, `command-recipe.md`,
`compaction-recipe.md`, `context-and-memory.md`, `evals.md`,
`packaging.md`, `production.md`, `skills-and-context.md`,
`reading-short-prompts.md`) — use them for from-scratch authorship.
