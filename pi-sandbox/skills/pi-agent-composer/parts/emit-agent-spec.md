# Component: `emit-agent-spec.ts`

**Location:** `pi-sandbox/.pi/components/emit-agent-spec.ts`

## What it does

Pi extension loaded into the **parent** composer session via
`pi -e <path>`. Registers a single tool `emit_agent_spec` whose
TypeBox schema IS the YAML spec shape. The tool's `execute()` is
**not** a stub — it validates the args against composition rules
and writes `<PI_SANDBOX_ROOT>/.pi/agents/<spec.name>.yml`.

Differs from every other component in this catalog: it is loaded
into the parent, not delegated to a child, and has no `parentSide`
export. The composer LLM calls it directly.

## When to use

- **Always.** It is the composer's only output channel. The
  `agent-composer.sh` tool allowlist exposes `emit_agent_spec`
  plus read verbs — there is no other way to commit a result.

## When NOT to use

- Never inside a phase declaration. `emit_agent_spec` is parent-
  side; child phases use the canonical five components
  (cwd-guard, stage-write, emit-summary, review, run-deferred-writer).

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

`emit_agent_spec`. The composer harness adds `read,ls,grep`
alongside; no write verbs are exposed.

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
