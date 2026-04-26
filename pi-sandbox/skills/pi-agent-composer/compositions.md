# Compositions

Three topologies the YAML composer can emit. Pick one with the
cascade in `procedure.md` §3. The fourth —
`rpc-delegator-over-concurrent-drafters` — is **deferred**; the
composer emits GAP for it (see §"orchestrator-with-LLM-reviewer"
below).

The runner that consumes these YAML specs lives at
`pi-sandbox/.pi/extensions/yaml-agent-runner.ts`. It auto-discovers when
pi runs in `pi-sandbox/`, globs `.pi/agents/*.yml`, and registers one
slash command per spec.

## Template variables

Phase prompts may reference these — the runner substitutes them just
before each `delegate()` call:

- `{args}` — the slash-command argument the user passes at runtime.
- `{sandboxRoot}` — absolute path of the pi-sandbox cwd.
- `{brief}` — phase 2 of `sequential-phases-with-brief` only; built
  from phase 1's `emit_summary` calls, capped at 16 KB.

## single-spawn

- **When:** one child, one phase. Recon-style (read-only +
  `emit_summary`), confined-drafter (writes via `sandbox_write`),
  drafter-with-approval (stages via `stage_write`, parent confirms,
  parent promotes).
- **User-listed component sets that infer to this** (cwd-guard and
  sandbox-fs are auto-injected — never listed):
  - `[emit-summary]` — recon (read-only). Add the read sandbox verbs
    to `tools`; sandbox-fs activates with that subset.
  - `[]` (empty) — confined drafter; child writes directly via
    `sandbox_write`/`sandbox_edit` requested in `tools`.
  - `[stage-write]` — drafter with approval (human gate).
- **YAML to emit:**
  ```yaml
  name: my-drafter
  slash: my-drafter
  description: Drafts files; user approves before disk
  composition: single-spawn
  phases:
    - components: [stage-write]
      tools: [sandbox_ls, stage_write]   # sandbox_ls activates sandbox-fs with that one verb
      prompt: |
        You are a DRAFTER. Task: {args}.
        Stage files via stage_write under {sandboxRoot}.
        Reply DONE when finished.
  ```
- **What the runner does:** one `delegate()` call. Component name →
  `parentSide` resolution from a static map; tier inference picks
  `$TASK_MODEL` (no `review` / `run-deferred-writer` present).
- **Confirm/promote gate:** auto-applied by `delegate()` when
  `stage-write ∈ components` (rails.md §10).

## sequential-phases-with-brief

- **When:** scout-then-draft. Phase 1 child surveys via
  `emit_summary`; the runner assembles a brief from harvested
  summaries; phase 2 drafter receives the brief in-prompt as
  `{brief}` and stages writes via `stage_write`.
- **Required component sets (enforced by `emit_agent_spec`):**
  phase 1 must include `emit-summary`; phase 2 must include
  `stage-write`.
- **YAML to emit:**
  ```yaml
  name: scout-then-draft
  slash: scout-then-draft
  description: Survey {args}, then draft missing pieces
  composition: sequential-phases-with-brief
  phases:
    - name: scout
      components: [emit-summary]
      tools: [sandbox_ls, sandbox_read, sandbox_grep, sandbox_glob, emit_summary]
      prompt: |
        Survey {args}. Use emit_summary for each finding.
    - name: draft
      components: [stage-write]
      tools: [sandbox_ls, stage_write]
      prompt: |
        Task: {args}

        <brief>
        {brief}
        </brief>

        Stage missing pieces under {sandboxRoot}. Reply DONE.
  ```
- **What the runner does:** phase-1 `delegate()`, harvest
  `byComponent.get("emit-summary").summaries`, build the brief
  (cap 16 KB byte length, abort with notify if exceeded), template-
  substitute `{brief}` into phase-2's prompt, phase-2 `delegate()`.
- **Confirm/promote gate:** auto-applied on phase 2 (`stage-write`
  present, `review` absent).

## single-spawn-with-dispatch

- **When:** a dispatcher LLM that programmatically invokes other
  emitted agents (or the composer itself) via `dispatch_agent({name,
  args})`. Covers fan-out, sequential orchestration, and the
  meta-composer pattern (dispatcher asks the composer to design
  a sub-agent, then dispatches the freshly-emitted agent on the
  next turn). No LLM reviewer involved — if the user wants
  verdict-driven approve/revise, that's still GAP.
- **Required component / tool combination (enforced by
  `emit_agent_spec` and the runner):**
  - `components: [dispatch-agent]` (only entry needed; sandbox-fs
    auto-injects if you list any sandbox_* read verb in `tools`).
  - `tools` MUST include `dispatch_agent`. Optionally add
    `sandbox_read,sandbox_ls,sandbox_grep,sandbox_glob` if the
    dispatcher should inspect the project before deciding what
    to dispatch. NEVER add `stage_write`, `sandbox_write`, or
    `sandbox_edit` — the dispatcher's only side-effect channel
    is `dispatch_agent` itself.
- **YAML to emit:**
  ```yaml
  name: my-orchestrator
  slash: my-orchestrator
  description: Dispatches drafters / composer on demand
  composition: single-spawn-with-dispatch
  phases:
    - components: [dispatch-agent]
      tools: [dispatch_agent]
      prompt: |
        You orchestrate sub-agents. Task: {args}.

        Use dispatch_agent({name, args}) to invoke any agent in
        .pi/agents/. Use the special name `composer` to ask the
        pi-agent-composer skill to design a brand-new sub-agent
        on demand.

        Each call's gates render in the user's TUI; you'll see
        the result in the next message before deciding the next
        dispatch. Reply DONE when complete.
  ```
- **What the runner does:** one `delegate()` call. The
  `dispatch-agent` parentSide harvests every `dispatch_agent`
  call into a state list; `finalize` runs them sequentially
  through `runSpec` (for YAML lookups) or a direct
  `delegate()` call (for the `composer` virtual entry),
  threading `ctx` through so nested gates render in the user's
  TUI regardless of how deep the chain goes. Tier inference
  picks `$LEAD_MODEL` because `dispatch-agent` is in the
  component set (orchestrator role).
- **Confirm/promote gate:** the dispatcher itself doesn't write
  files (no `stage-write` in the component set), so
  `delegate()`'s rails.md §10 gate doesn't fire. The gates
  belong to the dispatched sub-agents.

## orchestrator-with-LLM-reviewer (deferred — emit GAP)

- **When:** persistent RPC delegator LLM dispatches multiple
  drafters via `run_deferred_writer` and reviews their drafts via
  `review`; LLM verdict is the gate, not human confirm.
- **Component sets that would imply this:** any set containing
  `review` or `run-deferred-writer`.
- **Status:** the YAML runner cannot drive an RPC session —
  `delegate()` is single-spawn json-mode only, and the orchestrator
  needs a persistent `--mode rpc` channel with phase-dependent
  prompts (see `pi-sandbox/.pi/extensions/delegated-writer.ts`).
  Both `emit_agent_spec` and the runner reject these component
  sets. The `single-spawn-with-dispatch` topology covers
  dispatch-without-review; if the ask requires LLM review of
  every dispatch, this is the topology you need and the answer
  is still GAP.
- **What to do:** the composer skill emits GAP via procedure.md
  step 5 and instructs the user to load `pi-agent-builder` for the
  orchestrator-with-reviewer shape. Do NOT attempt to express it
  in YAML.
