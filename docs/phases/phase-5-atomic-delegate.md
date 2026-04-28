# Phase 5 — atomic `delegate` replaces `agent-spawn`

**Goal.** Replace today's two-tool `delegate` + `approve_delegation` dance with a single atomic `delegate` tool that internally uses the mesh-routed submission flow built in Phases 4a + 4b. After this phase, `agent-spawn.ts`, `agent-status-reporter.ts`, `delegation-boxes.ts`, and the entire `--rpc-sock` mechanism are deleted; their concept lives on as a thin tool layered over the mesh primitives, exactly as ADR-0001 calls for.

**Behaviour after this phase:**
- A recipe with `agents: [recipe-name]` gets a single `delegate` tool. One call. Returns when the worker has emitted its submission and the artifacts are queued for the caller's end-of-turn approval.
- The worker spawns in a tmpdir scratch sandbox; supervisor=submitTo=caller; sealed off from other peers via `acceptedFrom: [caller]`.
- Worker's submitted artifacts queue alongside any of the caller's own deferred-* operations; one unified end-of-turn dialog.
- `--rpc-sock` and the parent-driven RPC approval forwarding mechanism are gone. Workers escalate through the bus (matching how Phase 3c's supervisor rail works).
- Everything that used to depend on `agent-spawn`'s globalThis registry, status envelopes over `--rpc-sock`, or the per-call socket in `os.tmpdir()` — gone or migrated.

This file is deleted in the PR that ships Phase 5.

---

## Prerequisite

- Phases 4a + 4b merged to main. The mesh-routed submission flow (worker emits → supervisor applies) is functional.
- Phase 4c (revision threading) **not strictly required**, but useful: an atomic delegate that can iterate via revise is more powerful. Doable in either order.
- All existing tmux smoke tests for the mesh flow pass.

## Required reading

- `docs/adr/0001-mesh-subsumes-delegation.md` — the architectural shape this phase makes real.
- `docs/adr/0003-supervisor-llm-in-review-loop.md` — supervisor-side decisions.
- `pi-sandbox/.pi/extensions/agent-spawn.ts` — the file you're replacing. Read end-to-end to understand the current contract (delegate's params, approve_delegation's flows, the watchdog timeout, the cleanup walker).
- `pi-sandbox/.pi/extensions/agent-status-reporter.ts` — gone after this phase.
- `pi-sandbox/.pi/extensions/delegation-boxes.ts` — likely repurposed (Phase 6c) or deleted; read to understand what it shows today.
- `pi-sandbox/.pi/extensions/_lib/submission-emit.ts` and `submission-apply.ts` — the building blocks you wrap.
- `pi-sandbox/.pi/extensions/_lib/escalation.ts` — the rpcSock fallback path; this phase removes it.
- `pi-sandbox/.pi/extensions/_lib/habitat.ts` — `rpcSock` and `delegationId` fields are removed in this phase.
- `scripts/run-agent.mjs` — the implicit-wire rule for `agent-spawn` is replaced; the `--rpc-sock` passthrough handling is removed.
- `pi-sandbox/agents/writer-foreman.yaml`, `delegator.yaml`, and any other recipe whose `prompt:` references `approve_delegation` — these need updating.
- The current "Companion to agent-spawn" header comment in `agent-bus.ts` — clean up while you're there.

## Skill

`/tdd`. The atomic-delegate logic has a testable core (subprocess spawn + bus listener + buffer + tear down) that can be unit-tested with mocked spawning and a synthetic worker.

## Branch

Off latest `main`. Suggested: **`claude/phase-5-atomic-delegate`**.

```sh
git fetch origin main
git checkout -b claude/phase-5-atomic-delegate origin/main
npm test   # confirm baseline
```

## Scope — what's in (one logical step per commit)

### Step 1 — `_lib/atomic-delegate.ts` (testable core)

The atomic-delegate's subprocess + buffer + apply lifecycle, factored out so unit tests don't need real spawn. Define a clean interface:

```ts
export interface AtomicDelegateContext {
  recipe: string;
  task: string;
  callerName: string;
  callerSandbox: string;          // canonical for apply
  busRoot: string;
  workspace?: { include: string[] };
  timeoutMs?: number;

  // Injectable for tests; production passes node:child_process spawn + the
  // real bus dispatch hook.
  spawnWorker: (args: SpawnArgs) => WorkerHandle;
  dispatchHookRegistry: GlobalDispatchHookRegistry;
}

export interface WorkerHandle {
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (sig?: NodeJS.Signals) => void;
}

export interface DelegateResult {
  ok: boolean;
  workerName: string;
  artifacts: Artifact[];     // empty if worker exited without emitting
  workerStdout: string;      // truncated to ~20 KB
  error?: string;
}

export async function runAtomicDelegate(ctx: AtomicDelegateContext): Promise<DelegateResult>;
```

**Tests first** in `_lib/atomic-delegate.test.ts`:
- Happy path: worker emits a submission with N artifacts → result has those artifacts → worker is killed.
- Worker exits without emitting (e.g. crash) → `artifacts: []`, `error: "child exited without submission"`.
- Worker times out → kill, return error.
- Workspace bundle: when `workspace.include` is set, files are copied into the worker's tmpdir before spawn.
- Sandbox containment: worker's `scratchRoot` is a fresh tmpdir that doesn't escape OS tmpdir.

**Then implementation:**

The flow inside `runAtomicDelegate`:
1. Generate a unique `workerName` (use `_lib/agent-naming.ts`'s `generateInstanceName`).
2. Allocate a fresh tmpdir for scratch.
3. If `workspace.include` is set, glob-expand against `callerSandbox` and copy files into scratch.
4. Build the worker's habitat overlay: `{supervisor: callerName, submitTo: callerName, agents: [], acceptedFrom: [callerName], peers: [callerName]}`.
5. Construct spawn args (using `--habitat-spec` overlay, `--mode rpc` for keepalive, the bus root, etc.).
6. Register a one-shot bus dispatch hook that resolves the result Promise when a `submission` envelope arrives from `workerName`.
7. Send the worker its first prompt: `agent_call({to: workerName, body: task})`. Or, if pi's RPC mode supports it, send via stdin.
8. Wait for either: submission arrives, worker exits without submission, or timeout.
9. Tear down the worker (kill, clean up tmpdir, remove dispatch hook).
10. Return the `DelegateResult`.

### Step 2 — `pi-sandbox/.pi/extensions/atomic-delegate.ts` (the extension)

Wraps the testable core with pi tool registration + deferred-confirm handler.

- Registers `delegate({recipe, task, workspace?, timeout_ms?})` tool.
- Each call:
  - Validates `recipe` is in `getHabitat().agents` (the allowlist).
  - Calls `runAtomicDelegate(...)` with production hooks (real spawn, real bus dispatch registration).
  - If result has artifacts, **registers them with `deferred-confirm`** as a buffered handler. The handler's `prepare()` returns the buffered artifacts as `Artifact[]` (no SHA recompute — already SHA'd by the worker); apply writes to canonical via `applyArtifacts(callerSandbox, artifacts)`.
  - Returns synchronously to the model with a summary like `"Worker <name> drafted N artifacts; queued for end-of-turn approval"`.
- Tool description guides the model on params (no longer documents the two-step dance).

The crucial detail: the artifacts are queued with the rest of the caller's deferred operations. The unified preview shows them under a "Delegate" section header. Multiple `delegate` calls in one turn each register their own pending entry, surfaced as separate sections.

### Step 3 — `atomic-delegate.prompt.md`

Replaces `agent-spawn.prompt.md` and `agent-spawn.approval.prompt.md`. Documents the single-tool API. Significantly shorter than the two-tool docs were.

### Step 4 — implicit-wire rule update in `scripts/run-agent.mjs`

Today's `applyAgentsField` adds `agent-spawn` extension and `delegate` + `approve_delegation` tools when `agents:` is non-empty. Replace with: add `atomic-delegate` extension and only `delegate` tool. Drop `delegation-boxes` from the implicit-wire (Phase 6c will revisit if it gets repurposed; for Phase 5, drop it).

Inverse rejection: the existing checks for "loads agent-spawn but has no agents" become "loads atomic-delegate but has no agents." Updated error messages.

### Step 5 — drop `--rpc-sock` and `Habitat.rpcSock` / `delegationId`

- `_lib/habitat.ts`: remove `rpcSock?` and `delegationId?` fields from `Habitat`. Update `materialiseHabitat` to drop their parsing.
- `_lib/habitat.test.ts`: remove tests for those fields.
- `pi-sandbox/.pi/extensions/habitat.ts`: drop the AGENT_DEBUG line for those fields, drop the fallback Habitat's literal values.
- `_lib/escalation.ts`: drop the `rpcRequestApproval` function and the rpcSock branch in `requestHumanApproval`. Now the function is just `if (ctx.hasUI) return ctx.ui.confirm(...); else stderr-drop and return false;` — much smaller. The bus-routed escalation in `supervisor.ts`'s `escalate` action is the only escalation path now. Note: `escalateViaBus` in `supervisor.ts` previously had a "prefer bus, fall back to rpc-sock" branch. Phase 5 simplifies it to bus-only.
- `_lib/escalation.test.ts`: drop rpc-sock-related tests.
- `pi-sandbox/.pi/extensions/supervisor.ts`: drop the `rpcRequestApproval` import and the `rpcSock` fallback in the escalate action.
- `scripts/run-agent.mjs`: drop the `--rpc-sock` passthrough handling and the `delegationId` env-var capture.

### Step 6 — delete `agent-spawn.ts`, `agent-status-reporter.ts`, `delegation-boxes.ts`

Plus their `.prompt.md` files (`agent-spawn.prompt.md`, `agent-spawn.approval.prompt.md`).

`delegation-boxes.ts` is borderline — Phase 6c may repurpose it for a status envelope. **Recommendation: delete in Phase 5 and have Phase 6c rebuild the widget from scratch on a cleaner foundation.** The current implementation reaches into `agent-spawn`'s `__pi_delegate_pending__` registry that no longer exists.

### Step 7 — recipe migrations

Recipes whose `prompt:` references `approve_delegation` need updating to describe the single-tool flow. Identify them with:

```sh
grep -l approve_delegation pi-sandbox/agents/*.yaml
```

Likely candidates: `writer-foreman.yaml`, `delegator.yaml`, perhaps others. Update each prompt to describe `delegate({recipe, task, workspace?, timeout_ms?})` as a single call with no follow-up step. Reference `atomic-delegate.prompt.md` for the canonical wording.

Plus delete any references in `docs/agents.md` to `approve_delegation`, `--rpc-sock`, and the parent-driven approval flow that was specific to agent-spawn. Replace with the atomic-delegate description.

### Step 8 — clean up the "Companion to agent-spawn" comment in `agent-bus.ts`

The header comment block in `agent-bus.ts` says "Companion to agent-spawn (blocking delegation). The two are orthogonal: a recipe loads either, both, or neither." After Phase 5, agent-spawn doesn't exist. Replace with: "Companion to atomic-delegate. Atomic delegate uses the bus's submission flow internally; for explicit peer messaging, agents call agent_send / agent_call directly."

## Scope — what's NOT in

- **No status envelope kind on the bus.** Phase 6c. For Phase 5, the model gets a textual summary from `delegate`'s return value; there's no live progress indicator.
- **No `delegation-boxes`-style widget.** Phase 6c rebuilds.
- **No new envelope kinds.** All five (`message` + the four typed ones) already exist.
- **No `Habitat.canonicalRoot` field.** Phase 6 territory if needed.
- **No mesh-spawn changes.** `mesh-authority.ts`'s `mesh_spawn` continues to work for long-running peers; the atomic delegate is for ephemeral one-shots.

## Step-by-step checklist

```
[ ]  1. Read prereqs (especially agent-spawn.ts end-to-end + ADRs).
[ ]  2. /tdd.
[ ]  3. Branch claude/phase-5-atomic-delegate from main.

  STEP 1 — testable core:
[ ]  4. _lib/atomic-delegate.test.ts — happy path + crash + timeout +
        workspace + sandbox containment.
[ ]  5. _lib/atomic-delegate.ts — runAtomicDelegate.

  STEP 2 — extension:
[ ]  6. atomic-delegate.ts — tool registration + deferred-confirm
        handler registration + production wiring.
[ ]  7. atomic-delegate.prompt.md — single-tool API docs.

  STEP 3 — runner:
[ ]  8. run-agent.mjs — replace applyAgentsField's agent-spawn wiring
        with atomic-delegate; drop --rpc-sock passthrough handling and
        delegationId env capture.

  STEP 4 — drop rpc-sock everywhere:
[ ]  9. _lib/habitat.ts — remove rpcSock and delegationId fields;
        update tests; remove fallback object literal entries.
[ ] 10. habitat.ts extension — drop AGENT_DEBUG line for those fields.
[ ] 11. _lib/escalation.ts — drop rpcRequestApproval; simplify
        requestHumanApproval to UI-or-fail; update tests.
[ ] 12. supervisor.ts — drop rpcSock fallback in escalate action.

  STEP 5 — delete the old:
[ ] 13. Delete agent-spawn.ts, agent-status-reporter.ts,
        delegation-boxes.ts, agent-spawn.prompt.md,
        agent-spawn.approval.prompt.md.

  STEP 6 — recipes + docs:
[ ] 14. Migrate every recipe whose prompt references approve_delegation
        (use grep to find them). Update prompts.
[ ] 15. Update docs/agents.md: remove agent-spawn / --rpc-sock /
        approve_delegation references; describe atomic-delegate.
[ ] 16. agent-bus.ts header comment: drop "Companion to agent-spawn"
        line; reword for the new world.

[ ] 17. npm test — green. Test count delta should be modest:
        + atomic-delegate tests
        - dropped rpc-sock tests
        - dropped delegation-related tests in agent-spawn (was zero
          unit tests there anyway)

[ ] 18. Tmux smoke — the migrated writer-foreman recipe (now using
        single-call delegate):
        a) foreman calls delegate({recipe: "deferred-writer", ...})
        b) worker drafts, ships submission to foreman
        c) foreman's deferred-confirm rail surfaces the artifacts
        d) foreman approves at end-of-turn
        e) artifacts apply to foreman's sandbox

[ ] 19. Tmux smoke — delegator recipe with multiple parallel delegates
        (verify the bus dispatch hooks don't conflict).

[ ] 20. Commit per logical step (this phase has many steps; one
        commit per step keeps reviewing tractable).
[ ] 21. Push; delete this plan file.
```

## Acceptance criteria

- `delegate` tool exists, takes `{recipe, task, workspace?, timeout_ms?}`, returns synchronously after queueing artifacts.
- `approve_delegation` tool gone; agent-spawn.ts, agent-status-reporter.ts, delegation-boxes.ts, agent-spawn.*.prompt.md gone.
- `--rpc-sock` flag gone from runner and from any extension's flag registration.
- `Habitat.rpcSock` and `Habitat.delegationId` gone.
- `escalation.ts` contains only the UI-or-fail logic.
- `supervisor.ts`'s `escalate` action only uses bus.
- Recipes with `agents:` continue to launch and the migrated prompts describe single-call delegate.
- Tmux smokes (writer-foreman migrated, delegator migrated, parallel delegates) all pass.
- This plan file deleted.

## What to do if you hit something unexpected

- **`mesh-authority.ts` references agent-spawn.** Read the file; the `mesh_spawn` tool is independent of agent-spawn (it spawns long-running peers, not one-shot delegates). It should be untouched. If it imports anything from agent-spawn directly, that's a leak — surface in the PR description.
- **`delegation-boxes.ts` is referenced from a recipe or test you didn't anticipate.** Treat as a Phase 6c carry-forward: deleting in Phase 5 means the test/recipe needs to drop the reference. Not a Phase 5 blocker.
- **A recipe's prompt is more involved than a simple "two-tool dance" rewording.** Show the diff in the PR description; the user can review.
- **Worker spawn semantics differ from `mesh_spawn`'s.** They should — atomic delegate's worker has stricter habitat (acceptedFrom: [caller], agents: [], peers: [caller]). `mesh_spawn` is for general-purpose peers. Keep the implementations separate.

## Hand-back

Push to `origin/claude/phase-5-atomic-delegate`. Report:

- SHAs (one per logical step — likely 8-10 commits).
- npm test output.
- Tmux smoke results for all three test scenarios.
- Diff summary of recipe migrations (list each recipe touched and the lines changed).
- Anything you found in `mesh-authority.ts` or other files that referenced agent-spawn unexpectedly.

Don't open a PR. The user reviews directly.
