# Component: `dispatch-agent.ts`

**Location:** `pi-sandbox/.pi/components/dispatch-agent.ts`

## What it does

Pi extension that registers a **stub** tool `dispatch_agent({name,
args})`. The tool's `execute` is a no-op — it returns a confirmation
message but does not run the dispatched agent. The parent harvests
each `tool_execution_start` event for `dispatch_agent` from the
child's NDJSON stdout (`--mode json`) to recover `{name, args}`,
then in `finalize` runs the actual dispatch via `runSpec` from
`../lib/dispatch-spec.ts` (for YAML agents) or via a direct
`delegate()` call with the composer skill (for the special
`composer` virtual entry).

This means a dispatcher LLM can programmatically invoke other
emitted agents (or the composer itself) the same way a human user
would. Each dispatched agent's gates — `stage_write` confirms,
`emit_agent_spec` confirms, even nested `dispatch_agent` calls —
render in whichever process owns the user's TUI, because
`delegate()` threads the outer `ctx` through every layer.

## When to use

- The user's ask is **orchestrator-shaped**: "an agent that runs
  several drafters in sequence", "a workflow that asks the
  composer to design an agent and then runs it", "fan out to
  these N tasks and report back".
- Pair with `composition: single-spawn-with-dispatch`. That
  composition is the only one that wires `dispatch-agent` into
  the runner.
- The dispatcher LLM does the orchestration in its own chat
  context. It sees each dispatched agent's result before
  deciding the next dispatch. **No persistent state** — each
  dispatcher turn is one `delegate()` call. If the dispatcher
  needs to remember decisions across dispatches, prompt it to
  emit them inline in its own assistant text.

## When NOT to use

- The user wants a single drafter or recon (use `single-spawn`).
- The user wants a scout-then-draft pipeline (use
  `sequential-phases-with-brief`).
- The user wants an LLM reviewer to gate writes
  (`review` + `run-deferred-writer`). That's the RPC delegator
  topology — emit GAP and point at `pi-agent-builder`.
- Cross-process or remote dispatch. The dispatcher only resolves
  agents in the local sandbox's `.pi/agents/` directory.

## How `name` resolves

- Any string except `composer` → looked up against
  `<sandboxRoot>/.pi/agents/<name>.yml`. The YAML is parsed,
  validated against the runner's rules, and run via `runSpec`
  exactly as if the user had typed `/<slash> <args>` directly.
- The literal string `composer` → spawns the
  `pi-agent-composer` skill with the same tool surface as
  `scripts/agent-composer.sh` (`sandbox_read,sandbox_ls,
  sandbox_grep,emit_agent_spec`). The `args` becomes the
  natural-language description of the agent to design; the
  composer's YAML confirm dialog renders in the user's TUI on
  emit. This is the **meta-composer** path: a dispatcher can
  ask the composer to design a brand-new sub-agent on demand,
  then dispatch it on the next turn.

Unknown names return an error result listing every available
agent name plus the literal `composer`. The dispatcher LLM gets
that error in its next assistant message and can retry with a
valid name.

## Required `--tools` allowlist contribution

```
dispatch_agent
```

Optionally add read sandbox verbs (`sandbox_read`,
`sandbox_ls`, `sandbox_grep`, `sandbox_glob`) if the dispatcher
needs to inspect the project before deciding what to dispatch.
The dispatcher itself NEVER gets `stage_write`, `sandbox_write`,
`sandbox_edit`, or any built-in fs verb — its only side-effect
channel is `dispatch_agent`.

## Parent-side wiring

The `single-spawn-with-dispatch` composition is the only place
that should declare `dispatch-agent` in `components`. The runner's
`runSpec` call routes the spec to a single `delegate()` call with
`dispatch-agent.parentSide` in the components array. The
parentSide's `harvest` collects every `dispatch_agent` call into
a state list; `finalize` runs them sequentially after the child
exits, threading `fctx.ctx` into each nested `delegate()` call.

## YAML to emit

```yaml
name: my-orchestrator
slash: my-orchestrator
description: Dispatches drafters and the composer on demand
composition: single-spawn-with-dispatch
phases:
  - components: [dispatch-agent]
    tools: [dispatch_agent]
    prompt: |
      You orchestrate sub-agents. Task: {args}.

      Available sub-agents are listed in `.pi/agents/<name>.yml`.
      Use the special name `composer` to ask the pi-agent-composer
      skill to design a new sub-agent on demand.

      Each dispatch_agent({name, args}) call:
        - Runs the named agent in the user's TUI (gates render
          for the user to approve).
        - Returns a one-line summary in the next message.
      You see the result before deciding the next dispatch.

      Reply DONE when the task is complete.
```

## Worked example: meta-composer

A dispatcher that asks the composer to design a brand-new agent,
then dispatches it on the next turn:

```yaml
name: meta-orchestrator
slash: meta
description: Designs a sub-agent via the composer, then runs it
composition: single-spawn-with-dispatch
phases:
  - components: [dispatch-agent]
    tools: [dispatch_agent]
    prompt: |
      Goal: {args}

      Step 1: Use dispatch_agent({name: "composer", args: "<design
      brief>"}) to ask the pi-agent-composer skill to design an
      agent for this goal. The composer's YAML confirm will render
      in the user's TUI; if the user denies, ask them in chat what
      to change and re-dispatch the composer with the revised brief.

      Step 2: Once the composer's emit succeeds, you'll see the
      new agent's name in the dispatch result. Dispatch it via
      dispatch_agent({name: "<new-agent-name>", args: "<runtime
      args>"}). Its gates render in the user's TUI in turn.

      Reply DONE after the dispatched agent finishes.
```

The chat-layer revise loop is the cleaner UX answer to a denied
composer spec: the dispatcher LLM has its own conversation, so it
naturally asks "what would you like to change?" when the composer
returns `denied`. Compare with the standalone composer entry
(`npm run agent-composer:i`) where the same revise loop happens
inside the composer's own session.

## Validation notes

- `emit_agent_spec` rejects `dispatch-agent` declared under
  `single-spawn` or `sequential-phases-with-brief` — those
  compositions do not wire the parent-side dispatch loop.
- `single-spawn-with-dispatch` requires exactly 1 phase and
  requires `dispatch-agent` in components AND `dispatch_agent` in
  the explicit `tools` list. The runner will refuse to register a
  hand-edited spec that violates this.
- Print-mode dispatch (a parent `pi -p` running a dispatcher)
  cancels every gated sub-dispatch the same way the composer's
  print-mode flow cancels: `ctx.ui.confirm` returns false
  unconditionally. Dispatchers are interactive-only by design.

## Canonical example

The end-to-end dispatcher reference is built incrementally during
your first composer-emitted dispatcher session — there is no
checked-in canonical extension yet (the topology is new). Lean on
this part-doc and `compositions.md` for the YAML shape; the
runner's `runSpec` handles the dispatch wiring transparently.
