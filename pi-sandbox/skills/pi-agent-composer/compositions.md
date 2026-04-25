# Compositions

Two topologies the YAML composer can emit. Pick one with the cascade
in `procedure.md` §3. The third — `rpc-delegator-over-concurrent-drafters`
— is **deferred**; the composer emits GAP for it (see §"orchestrator"
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
- **Component sets that infer to this** (cwd-guard is in all of
  them — defense-in-depth applies to every spawn):
  - `[cwd-guard, emit-summary]` — recon (read-only sandbox verbs +
    `emit_summary`).
  - `[cwd-guard]` — confined drafter; child writes directly.
  - `[cwd-guard, stage-write]` — drafter with approval (human gate).
- **YAML to emit:**
  ```yaml
  name: my-drafter
  slash: my-drafter
  description: Drafts files; user approves before disk
  composition: single-spawn
  phases:
    - components: [cwd-guard, stage-write]
      tools: [sandbox_ls, stage_write]   # cwd-guard registers only sandbox_ls
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
      components: [cwd-guard, emit-summary]
      tools: [sandbox_ls, sandbox_read, sandbox_grep, sandbox_glob, emit_summary]
      prompt: |
        Survey {args}. Use emit_summary for each finding.
    - name: draft
      components: [cwd-guard, stage-write]
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

## orchestrator (deferred — emit GAP)

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
  sets.
- **What to do:** the composer skill emits GAP via procedure.md
  step 5 and instructs the user to load `pi-agent-builder` for the
  orchestrator shape. Do NOT attempt to express it in YAML.
