---
name: pi-agent-composer
description: Composes pi agents from a committed library of components (cwd-guard, stage-write, emit-summary, review, run-deferred-writer) without being constrained to fixed patterns. Use this skill when the user wants to compose a pi-coding-agent extension parts-first — pick whichever components the ask requires and wire them with one of three composition topologies (single-spawn, sequential-phases-with-brief, rpc-delegator-over-concurrent-drafters). Trigger on phrases like "compose pi agent", "parts-first", "component-driven", "pi extension that uses cwd-guard / stage-write / emit-summary / review / run-deferred-writer", or any ask of the form "build a pi agent that uses X" / "pi extension with component Y". This skill does NOT author from scratch — if the ask doesn't decompose into the known components, it STOPS and emits a GAP message so the user can fall back to `pi-agent-builder`.
---

# Pi Agent Composer

This skill composes agents by **picking components and wiring them
with a composition topology**. It is the parts-first counterpart to
`pi-agent-assembler`: where the assembler picks one of five fixed
patterns, the composer picks any subset of the five components and
infers the topology from the set.

If the user's request cannot be expressed in terms of the known
components, the skill **stops and emits a GAP message**. The gap
message is the whole point: when the library can't cover a shape,
you want that known rather than a confabulated extension.

## Cardinal rules

1. **Compose, don't author.** The components in
   `pi-sandbox/.pi/components/` are the vocabulary. Do not invent
   new child-tools, new stub shapes, or new NDJSON harvesters
   inside this skill.
2. **`cwd-guard.ts` on every write-capable sub-pi spawn.** Every
   generated agent that spawns a child pi process with a
   write-capable tool in its allowlist MUST load
   `pi-sandbox/.pi/components/cwd-guard.ts` via `-e <abs path>` and
   pin `PI_SANDBOX_ROOT` in the child's env. The sole exception is
   a read-only child whose only output channel is `emit_summary`
   (no filesystem contact, no write verbs in the allowlist).
3. **Output under `.pi/extensions/<name>.ts`, never the cwd root.**
   Pi auto-discovers extensions from `.pi/extensions/` under its
   cwd. A file at `./<name>.ts` loads as nothing; the user then
   sees "no artifacts" even though the model produced correct
   TypeScript. When invoking the sandboxed write tool, the `path`
   argument must start with `.pi/extensions/`.

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

## Compositions catalog

Three topologies. Pick one based on the component set; full detail
in `compositions.md`.

| Topology | When | Canonical reference |
| --- | --- | --- |
| `single-spawn` | One child, one phase. Covers recon-style, confined-drafter, and drafter-with-approval shapes. | `pi-sandbox/.pi/extensions/deferred-writer.ts` |
| `sequential-phases-with-brief` | Two or more children run serially; parent assembles a brief from phase 1's `emit_summary` output and passes it into phase 2's prompt. | (inline in `compositions.md` until `composer-scout-then-draft` lands) |
| `rpc-delegator-over-concurrent-drafters` | Persistent RPC delegator LLM dispatches drafters via `run_deferred_writer` and reviews their drafts via `review`; LLM verdict is the gate. | `pi-sandbox/.pi/extensions/delegated-writer.ts` |

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
- **Skipping cwd-guard on a write-capable child.** Non-negotiable
  on every write-capable spawn; the one exception is a read-only +
  `emit_summary`-only child. An agent that skips cwd-guard while
  handing the child `sandbox_write` / `write` / `edit` / `bash` is
  unsafe no matter how narrow the task looks.
- **Skipping the `rails.md` checklist.** Rails encode the always-on
  defaults from `pi-agent-builder/references/defaults.md`. Drift
  here re-introduces bugs the components were written to prevent.
- **Mixing composition topologies in one handler.** A single
  command dispatches one topology. If the user wants both an
  RPC-delegator and a separate drafter-with-approval flow, that's
  two slash commands.

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
