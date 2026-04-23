---
name: pi-agent-assembler
description: Composes documented, pre-tested parts from a committed library into Pi agents. Use this skill whenever the user wants to create a pi-coding-agent extension, sub-agent, slash command, or lifecycle hook and the request can be covered by one of the known patterns (recon / drafter-with-approval / confined-drafter / orchestrator). Trigger on phrases like "pi extension", "pi agent", "pi sub-agent", "registerTool", "ExtensionAPI", ".pi/extensions/", ".pi/components/", "recon", "drafter", "stage write", "emit summary", "orchestrator", or any ask to extend pi with behavior that fits a known shape. This skill does NOT author from scratch — if no pattern matches, it STOPS and emits a GAP message so the user can fall back to `pi-agent-builder`.
---

# Pi Agent Assembler

This skill composes agents from a **committed library of parts**. It is
the preferred skill for routine extension requests — recon agents,
drafter agents with approval gates, sandboxed drafters, and the
delegated-writer-style orchestrator.

If the user's request does not map to one of the patterns below, the
skill **stops and emits a GAP message**. The gap message is the whole
point: when the library can't cover a shape, you want that known
rather than a confabulated extension.

## Cardinal rules

1. **Compose, don't author.** The parts in `parts/` and the
   extensions in `patterns/` are the vocabulary. You do not write new
   child-tools, new stub shapes, or new NDJSON harvesters inside this
   skill.
2. **cwd-guard on every write-capable sub-pi spawn.** Every
   generated agent that spawns a child pi process with a write-capable
   tool in its allowlist MUST load
   `pi-sandbox/.pi/components/cwd-guard.ts` via `-e <abs path>` and
   pin `PI_SANDBOX_ROOT` in the child's env. This is the safety
   rail that keeps a child from writing outside its run cwd. The
   sole exception is the recon pattern, whose child has a read-only
   allowlist plus `emit_summary` (no filesystem contact) — no
   write channel, nothing to sandbox.
3. **If no pattern matches, STOP.** Emit the GAP template from
   `procedure.md`. Do not improvise a new pattern in place.
4. **Write to `.pi/extensions/<n>.ts`**, not to the cwd root. Pi
   auto-discovers extensions from `.pi/extensions/` under its cwd.
   A file at `./<n>.ts` loads as nothing; the user then sees "no
   artifacts" even though the model produced correct TypeScript.
   When invoking the sandboxed write tool, the `path` argument
   must start with `.pi/extensions/` — e.g. `.pi/extensions/my-agent.ts`.

## Parts catalog

All parts live in `pi-sandbox/.pi/components/<n>.ts` and are loaded
into child pi processes via `pi -e <abs path>`.

| Part | Role | When to use |
| --- | --- | --- |
| `cwd-guard.ts` | Sandbox for child writes | **REQUIRED on every write-capable sub-pi spawn.** Registers `sandbox_write` + `sandbox_edit`; both reject paths outside `$PI_SANDBOX_ROOT`. Replaces built-in `write` / `edit`. Recon children skip it — they have no write channel at all. |
| `stage-write.ts` | Stub drafter channel | The child should draft files the *parent previews and approves* before anything hits disk. Child calls `stage_write({path, content})`; parent harvests from NDJSON `tool_execution_start` events and `fs.writeFileSync`s only on user approval. |
| `emit-summary.ts` | Stub structured-output channel | The child should return one or more *named summaries* instead of free-form assistant text. Child calls `emit_summary({title, body})`; parent harvests from NDJSON `tool_execution_start` events, caps byte-length per body, and persists / forwards the result. The recon pattern's primary output channel. |
| `review.ts` | Stub reviewer verdict | An orchestrator LLM renders `approve`/`revise` verdicts on staged drafts. Parent harvests the verdicts and loops (dispatch → review → revise) up to a bounded iteration count. |

Per-part detail: `parts/cwd-guard.md`, `parts/stage-write.md`,
`parts/emit-summary.md`, `parts/review.md`.

`pi-sandbox/.pi/components/run-deferred-writer.ts` also ships in the
library, but it is the delegated-writer pattern's dispatch stub
specifically — documented inline in `patterns/orchestrator.md`, not a
reusable part.

## Patterns catalog

One pattern per shape. Each lists required parts and ships a short
TypeScript skeleton with TODO-marked insertion points.

| Pattern | Problem shape |
| --- | --- |
| `patterns/recon.md` | **Read-only survey.** Child walks a directory / codebase and emits one or more structured summaries via `emit_summary`. No side effects. |
| `patterns/drafter-with-approval.md` | **Single drafter + user gate.** Child stages writes in parent memory via `stage_write`; parent previews via `ctx.ui.confirm` and promotes approved drafts. Canonical: `deferred-writer.ts`. |
| `patterns/confined-drafter.md` | **Single drafter, no approval gate.** Child writes freely but only inside a scoped cwd via `cwd-guard.ts`. Use when a human-confirm loop would hurt more than it helps (batch / scripted runs, agent-maker). |
| `patterns/orchestrator.md` | **Delegator over drafters + LLM review.** One RPC delegator LLM dispatches drafters (via `run_deferred_writer` stub) and reviews drafts (via `review.ts`); parent harvests both stubs from NDJSON. Canonical: `delegated-writer.ts`. |

## How to use this skill

Follow `procedure.md` exactly:

1. **Classify** the user's prompt against the pattern rows above.
2. **Pick parts** — the pattern's parts list is authoritative.
3. **Verify cwd-guard** is first in the parts list for every
   write-capable child (recon's child is read-only + `emit_summary`,
   so it loads `emit-summary.ts` in cwd-guard's place).
4. **Emit glue** from the pattern's skeleton, filling TODO slots.
5. **If step 1 is not a confident match, STOP and emit the GAP
   message** exactly as given in `procedure.md`.

## When to fall back to pi-agent-builder

Load the `pi-agent-builder` skill instead when:

- The user's request doesn't map to any pattern here (the GAP
  message tells you this).
- The user wants a non-sub-agent extension (a custom-UI widget, a
  compaction strategy, an event-handler-only extension, a context
  injector, session-persistence work, a pi package).
- A pattern *almost* matches but the user needs a variant that
  would require a new kind of stub or a new NDJSON event type.
  Authoring from primitives is pi-agent-builder's job.

`pi-agent-builder` carries the API-surface references
(`tool-recipe.md`, `events-recipe.md`, `command-recipe.md`,
`compaction-recipe.md`, `context-and-memory.md`, `evals.md`,
`packaging.md`, `production.md`, `skills-and-context.md`,
`reading-short-prompts.md`) — use them for from-scratch authorship.

## Naming conventions

Part names encode intent. Pick the bucket first; name the tool
second. If no bucket fits, raise it — the library's coherence is
worth the pause.

| Prefix / name | Semantics | Examples |
| --- | --- | --- |
| `stage_*` | Child proposes a side effect; parent holds the commit. The stub returns immediately; the parent decides later whether to persist. | `stage_write`. Future candidates: `stage_exec`, `stage_http_call`. |
| `emit_*` | Structured-output harvest; no side effect deferred. The parent receives a named piece of structured text to display / persist / forward. | `emit_summary`. Future candidates: `emit_finding`, `emit_metric`. |
| role name | Purpose-specific stub. Used when no prefix family fits, typically because the tool is single-use inside one pattern. | `review`, `run_deferred_writer`. Future candidate: `ask_user`. |

## Anti-patterns

- **Inventing a new part in a user session.** The library is
  closed; if a new child-tool shape is needed, that's a GAP, not
  an opportunity to improvise.
- **Skipping cwd-guard on a write-capable child.** Non-negotiable
  on every write-capable spawn; the one exception is the recon
  child (read-only + `emit_summary`, no filesystem contact). An
  agent that skips cwd-guard while handing the child `sandbox_write`
  / `write` / `edit` / `bash` is unsafe no matter how narrow the
  task looks.
- **Paraphrasing a pattern's skeleton.** Use the template as-is.
  Tweaking boilerplate re-introduces the failure modes the patterns
  were written to prevent (see `pi-agent-builder/references/defaults.md`
  for the catalog).
- **Mixing patterns.** If recon wants a write channel, it's no
  longer recon — pick `confined-drafter` or `drafter-with-approval`.
