# Component: `emit-agent-spec.ts`

**Location:** `pi-sandbox/.pi/components/emit-agent-spec.ts`

## What it does

Pi extension loaded into the composer session via `pi -e <path>`.
Registers a single tool `emit_agent_spec` whose TypeBox schema IS
the YAML spec shape. The tool's `execute()` validates the args
against composition rules, then EITHER writes the YAML inline
after a user-confirm dialog (interactive composer session) OR
returns the staged payload for a parent-side gate (sub-agent
context).

Branches on `ctx.hasUI`:
- **`hasUI === true`** (the default `npm run agent-composer:i`
  entry): the in-child gate fires. `ctx.ui.confirm` shows the
  full YAML to the user; on approve the file lands at
  `<PI_SANDBOX_ROOT>/.pi/agents/<spec.name>.yml`; on deny the
  call returns `isError: true` with `details.cancelled: true`
  and nothing is written.
- **`hasUI === false`** (sub-agent under `delegate()`, or
  print-mode `pi -p`): no inline gate — the call returns a
  staged success payload (`details.staged: true, yaml, …`) and
  the parent-side `finalize` runs the gate via its own
  `ctx.ui.confirm`. If the parent has no UI either (true print-
  mode-all-the-way-up), the call cancels with reason `"no-ui"`.

This component DOES export a `parentSide` (the dual-mode requires
it), but it's only consumed by orchestrators that drive the
composer through `delegate()`. The direct human entry doesn't
hit `parentSide`.

## When to use

- **Always.** It is the composer's only output channel. The
  `agent-composer.sh` tool allowlist exposes `emit_agent_spec`
  plus read verbs — there is no other way to commit a result.

## When NOT to use

- Never inside a phase declaration. `emit_agent_spec` is parent-
  side; child phases use the canonical five components
  (cwd-guard, stage-write, emit-summary, review, run-deferred-writer).

## User approval gate (LLM contract)

Every emit goes through a user confirm before the YAML lands on
disk. The LLM's contract:

- Treat `isError: true` (with `details.cancelled: true` and
  `details.reason: "denied"`) as **the user denied this spec**.
  The YAML was NOT written.
- On denial, **ask the user what they would like to change**, in
  natural language, then re-emit the spec with their revision
  baked in. Do NOT silently retry with a synthesized different
  name; the user's reply IS the revision instruction.
- "Call exactly once per agent" still holds. If the user wants a
  second related agent in the same conversation, that's a second
  call — not a retry.
- `details.staged: true` (sub-agent context) means the parent
  process will run the gate; the composer doesn't need to do
  anything different at that layer. `details.staged: false`
  means the file already landed (or was denied via isError).

## Tool schema (call it like this)

```
emit_agent_spec({
  name: "<filename-no-ext>",         // [a-z][a-z0-9-]{1,40}
  slash: "<slash-command-no-prefix>",// [a-z][a-z0-9-]{1,40}
  description: "<one-line>",         // shown in pi's /help
  composition: "single-spawn" | "sequential-phases-with-brief",
  phases: [
    {
      name: "<optional log label>",
      components: ["cwd-guard", "stage-write", ...],
      prompt: "<phase prompt with template vars>",
    },
    // up to 2 phases
  ],
})
```

## Validation rules (enforced by `execute`)

- `single-spawn` → exactly 1 phase.
- `sequential-phases-with-brief` → exactly 2 phases. Phase 1 must
  include `emit-summary`; phase 2 must include `stage-write`.
- `review` and `run-deferred-writer` are **rejected** with a
  pointer to `pi-agent-builder` — the YAML composer does not
  cover the orchestrator topology.
- `name` collision with an existing `.pi/agents/<name>.yml` is
  rejected (specs are immutable in a session — pick a new name).
- Path validation against `$PI_SANDBOX_ROOT` rejects `..` segments
  and absolute paths.

## Template variables (substituted by the runner at call time)

- `{args}` — the slash-command argument the user passes when
  invoking the agent.
- `{sandboxRoot}` — absolute path of the pi-sandbox cwd.
- `{brief}` — phase 2 of `sequential-phases-with-brief` only;
  built from phase 1's `emit_summary` calls, capped at 16 KB.

Use them inside the `prompt:` strings; the runner replaces them
just before each `delegate()` call.

## Required `--tools` allowlist contribution

`emit_agent_spec`. The composer harness pairs this with cwd-guard
loaded with `verbs: ["sandbox_read", "sandbox_ls", "sandbox_grep"]`
so the composer can introspect the project before emitting the
spec; no write verbs are exposed.

## Parent-side wiring

None — this component does not have a `parentSide` export. The
composer harness loads it via `-e` directly into the parent pi
session.

## What the runner does with the YAML

Once `<name>.yml` exists, the auto-discovered
`pi-sandbox/.pi/extensions/yaml-agent-runner.ts` registers
`/<spec.slash>` on the next pi startup. The handler imports the
declared components' `parentSide` exports from a static map and
dispatches each phase via `delegate()`. The runner refuses to
register specs with composition values it cannot drive
(`rpc-delegator-over-concurrent-drafters`) or with components it
cannot wire (`review`, `run-deferred-writer`).
