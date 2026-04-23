---
name: pi-agent-builder
description: Build Pi coding agent extensions and sub-agents in TypeScript. Use this skill whenever the user wants to create, modify, or ship anything for the Pi ecosystem — including pi-coding-agent extensions, sub-agents, custom tools, slash commands, lifecycle hooks, compaction customization, session persistence, or pi packages. Trigger on phrases like "pi extension", "pi agent", "pi sub-agent", "pi tool", "pi command", "registerTool", "ExtensionAPI", "~/.pi/agent/", ".pi/extensions/", or any request to extend, automate, or customize pi behavior. Also use when the user wants to build a multi-agent workflow on pi (scout → planner → worker), write evals for a pi extension, or harden one for production. If in doubt and pi is mentioned, use this skill.
---

# Pi Agent Builder

This skill teaches you to build high-quality extensions and sub-agents for the **Pi coding agent** (`@mariozechner/pi-coding-agent`). Pi is deliberately minimal — it ships a small tool set and defers sub-agents, plan mode, permission gates, browser automation, and similar features to extensions. Your job is to build those extensions well.

> **Before authoring from scratch: check `pi-agent-assembler`.**
> If the user's request fits one of its documented patterns (recon,
> drafter-with-approval, confined-drafter, orchestrator), prefer
> that skill — it composes already-tested parts and is faster and
> safer for common shapes. Use THIS skill for from-scratch
> authorship when the assembler flagged a gap, or for shapes the
> assembler doesn't cover (custom UI widgets, compaction
> strategies, event-only extensions, context injection, session
> persistence, pi packages).

The cardinal rule: **when in doubt, read Pi's own docs and source.** Pi is self-documenting — `~/.nvm/.../pi-coding-agent/README.md`, `docs/extensions.md`, `docs/compaction.md`, and `examples/extensions/` are the ground truth. If an API detail isn't in this skill, grep the installed package before guessing.

## When to use this skill

Use it for any of these:

- Writing a new extension (tools, commands, keyboard shortcuts, event handlers)
- Building sub-agents that delegate work to isolated child sessions
- Intercepting tool calls (approval gates, sandboxing, logging, redirection)
- Customizing context (injection, pruning, RAG, memory across sessions)
- Customizing compaction (topic-aware summaries, different summarizer model)
- Packaging extensions/skills/prompts/themes as a pi package for npm or git
- Writing evals to verify an extension works
- Hardening an extension for production (security, errors, telemetry)

If the user asks about something adjacent — "how do I use pi skills?", "what's AGENTS.md?" — still use this skill; route them to `references/skills-and-context.md`.

## The shape of a Pi extension

Every extension is a TypeScript module with a default-exported function that receives an `ExtensionAPI`. The factory can be sync or async; pi awaits async factories before `session_start`, so use async for one-time startup work (fetching model lists, remote config).

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({ /* ... */ });
  pi.registerCommand("mycmd", { /* ... */ });
  pi.on("tool_call", async (event, ctx) => { /* ... */ });
}
```

**Placement determines behavior:**

| Location | Behavior |
|---|---|
| `.pi/extensions/<n>.ts` (project-local) | **Default.** Auto-discovered when pi's cwd is this project; tracked in git so it ships with the repo |
| `.pi/components/<n>.ts` (project-local) | Curated reusable child-only parts; loaded by a parent extension via `pi -e <abs path>`. Not auto-discovered, so safe for stubs that shadow built-ins (e.g. `stage_write` replacing `write`). |
| `~/.pi/agent/extensions/<n>.ts` | Global, for user-installed extensions. **Not** where to put an extension you are generating *for a user* — their repo is not your HOME. |
| `pi -e ./path.ts` | Quick test; **not** hot-reloadable |
| Pi package (npm/git) | Installed via `pi install npm:@scope/name` |

**When in doubt, write to `.pi/extensions/` and `.pi/components/` under the project's sandbox directory** (i.e. relative to pi's current cwd, NOT `$HOME`). An extension that writes to `~/.pi/agent/extensions/` when generating code for a project leaks into the user's global config and is invisible inside their repo — the opposite of what "build me an extension for X project" means.

## The five things an extension can do

1. **Register LLM-callable tools** via `pi.registerTool(spec)` — the LLM can invoke these like built-in tools.
2. **Register slash commands** via `pi.registerCommand(name, spec)` — the user types `/name` in the TUI.
3. **Subscribe to lifecycle events** via `pi.on(event, handler)` — intercept, observe, or cancel.
4. **Drive the UI** via `ctx.ui` — `notify`, `confirm`, `select`, `input`, `custom` TUI components.
5. **Persist state** via `pi.appendEntry(...)` — store data that survives restarts.

That's the whole surface. Everything else is composition.

## Decision tree: what are you building?

```
What does the user want to build?
├── "A tool the LLM can call"           → See references/tool-recipe.md
├── "A slash command"                   → See references/command-recipe.md
├── "Intercept / block / log something" → See references/events-recipe.md
├── "A sub-agent / delegation"          → See references/subagent-recipe.md
├── "Context / memory / RAG"            → See references/context-and-memory.md
├── "Custom compaction"                 → See references/compaction-recipe.md
├── "Package for distribution"          → See references/packaging.md
├── "Evals for the extension"           → See references/evals.md
└── "Production hardening"              → See references/production.md
```

Read only the reference files you need. Each one is self-contained.

## Workflow: how to actually build one

Do these steps in order. Skipping any of them produces extensions that look fine but misbehave in real sessions.

### 1. Read the prompt; apply defaults and signal inferences

Short, natural-language prompts are the norm, not the exception. The user
rarely hands you a full spec — they describe the *behaviour* they want and
expect you to translate. Do it in this order:

1. **Match the prompt against `references/reading-short-prompts.md`.**
   Every phrase in its signal table implies a specific rail. Include each
   matched rail in what you build, whether or not the user spelled it out.
2. **Apply every rail in `references/defaults.md`.** These are the
   safety rails that apply to every extension of their kind —
   `--no-extensions` on child processes, confirmation gates on
   side-effectful commands, sha256 verification on writers, etc. Skip a
   rail only if the user *explicitly* told you to.
3. **Then** check for residual ambiguity the above can't resolve. Ask
   narrowly, with the default you'd pick if the user shrugs, about:
   - **What exactly triggers this?** (Command vs tool vs event handler —
     usually the signal table decides.)
   - **What failure modes beyond the defaults matter here?** Most are
     already covered; ask only if something task-specific isn't.
   - **Does this interact with other extensions?** Extensions are isolated
     by design; if coordination is needed, use events, not imports.

If nothing is residually ambiguous, build without asking. Round-trips are
expensive; the signal table + defaults exist so short prompts produce
correct, safe code on the first pass.

### 2. Pick the right primitive

A common mistake is building a tool when a command (or vice versa) is the right fit:

- **Tool (`registerTool`)** — the **LLM** calls it mid-conversation to accomplish a task. Parameters are a TypeBox schema the LLM fills in. Output goes into context.
- **Command (`registerCommand`)** — the **user** types `/name` in the TUI. Arguments are a raw string. Output is side-effectful (UI, state), not context.
- **Event handler (`pi.on`)** — runs on a lifecycle hook. Can observe, modify, or cancel.

A good rule: if the LLM would plausibly decide to use it, it's a tool. If the user invokes it consciously, it's a command. If it runs on every turn regardless of intent, it's an event handler.

### 3. Write it, following the relevant recipe

Open the matching file in `references/`. Each recipe has a minimal working example, the full API shape, and the top three failure modes. Stay faithful to the patterns — Pi's conventions exist because they interact with the TUI, session persistence, and compaction.

### 4. Test it live

```bash
# Quick one-off load (not hot-reloadable):
pi -e ~/.pi/agent/extensions/my-extension.ts

# Or drop the file into ~/.pi/agent/extensions/ and:
pi
# Then in the TUI: /reload
```

Verify three things by hand before writing any automated evals:

1. **Loads without errors.** If pi prints a stack trace on startup, fix that first.
2. **The LLM discovers and uses the tool correctly.** Ask pi a task that should trigger it. Watch the tool call. If the LLM misuses it, your `description` or `parameters` schema needs work.
3. **Failures degrade gracefully.** Kill your backend, unplug the network, pass bad input — the tool should return a helpful error in the `content`, not throw.

### 5. Write evals (if the behavior is objectively verifiable)

See `references/evals.md`. Skip for subjective things (style, creativity). Essential for anything with a deterministic contract (a linter, a deploy tool, a data transform).

### 6. Harden for production (if shipping)

See `references/production.md`. The short version: validate inputs, redact secrets from logs, set timeouts on network calls, truncate outputs, handle `AbortSignal`, and make the extension safe to `/reload`.

## Anti-patterns to avoid

These are the mistakes that turn up repeatedly. Avoid them from the start.

- **Huge tool outputs.** Do not dump a 200KB file contents into a tool result. Truncate to the portion the LLM needs, or write to disk and return the path.
- **Silent failures.** If a tool fails, return a `content` block that explains the failure in natural language. Don't swallow the error and return success.
- **Global mutable state without cleanup.** If you hold resources (connections, subprocesses, watchers), clean them up in `session_shutdown`. Hot-reload will leak otherwise.
- **Bypassing `ctx.ui` for output.** Don't `console.log` — it mangles the TUI. Use `ctx.ui.notify` or the tool's return value.
- **Registering the same name as a built-in.** Check existing tool names (`bash`, `read`, `write`, `edit`, `grep`, `glob`, `ls`, etc.) before picking one. Collisions cause confusing behavior.
- **Treating the LLM like a human.** Tool descriptions are prompts. The LLM reads them to decide when and how to call your tool. Be precise; include when-to-use guidance and parameter constraints.
- **Assuming parameter names the LLM will produce.** Match TypeBox schemas carefully. Use `StringEnum` for constrained strings — required for Google/Gemini compatibility.
- **Blocking the event loop.** Long-running work goes in an async path with progress via `onUpdate`. The TUI freezes if you don't yield.

## When to build a sub-agent instead of a tool

If the work is **a self-contained sub-task** (recon, audit, parallelizable chunk), build a sub-agent — a child pi session with its own context window. The parent agent calls it as a tool. Benefits: isolated context, can run in parallel, can use a cheaper model (haiku for recon, sonnet for implementation).

If the work is **a single focused action** (deploy, lookup, compute), build a plain tool. Sub-agents are overkill.

Full patterns in `references/subagent-recipe.md`, including the scout → planner → worker pipeline and context-isolation mode selection (`spawn` vs `fork`).

## Verifying facts against the installed package

Pi's API changes. Before writing non-trivial code, verify against the installed version:

```bash
# Find the installed package
npm root -g
# Read the current API surface
cat ~/.nvm/versions/node/*/lib/node_modules/@mariozechner/pi-coding-agent/dist/extensions/types.d.ts
# Read the current docs
ls ~/.nvm/versions/node/*/lib/node_modules/@mariozechner/pi-coding-agent/docs/
```

If a field, event, or method in this skill doesn't exist in the installed types, **trust the types, not the skill**, and flag the discrepancy to the user.

## The meta-move: ask Pi to build it

Pi itself is the fastest way to build a Pi extension. It can read its own source and docs. A reasonable prompt to give Pi:

> Read your own README and docs/extensions.md, then build me an extension in ~/.pi/agent/extensions/ that [does X]. It should register a tool called [name] with parameters [schema]. Handle [failure modes]. Truncate outputs to [limit]. When done, reload and try it once to verify it works.

This is often faster than writing the extension by hand, and the result is grounded in the actual installed API. Use this skill to guide *what* to build; let Pi handle *how* when possible.

---

## Reference files

Load these as needed based on the decision tree above.

- `references/reading-short-prompts.md` — Signal → rail table for inferring implementation shape from a short user prompt (load this *first* when the user's ask is natural-language rather than a spec).
- `references/defaults.md` — Safety rails to apply on every build unless the user explicitly opts out.
- `references/tool-recipe.md` — Full `registerTool` spec, TypeBox schemas, streaming updates, error handling.
- `references/command-recipe.md` — `registerCommand`, argument parsing, side effects.
- `references/events-recipe.md` — All lifecycle events, blocking vs observing, return-value semantics.
- `references/subagent-recipe.md` — Sub-agent delegation, `spawn` vs `fork`, depth limits, multi-agent pipelines.
- `references/context-and-memory.md` — The `context` event, RAG, persistent memory via `appendEntry`, AGENTS.md and SYSTEM.md.
- `references/compaction-recipe.md` — Customizing summarization, `session_before_compact`, using a different model.
- `references/packaging.md` — Pi packages, `package.json` shape, publishing to npm or git, version pinning.
- `references/evals.md` — Writing evals for extensions, deterministic vs judge-based, the `pi -e` test harness.
- `references/production.md` — Security, secrets, timeouts, `AbortSignal`, telemetry, graceful reloads.
- `references/skills-and-context.md` — Pi skills (different from Claude skills), AGENTS.md, SYSTEM.md, prompt templates.
