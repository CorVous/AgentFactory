# Composition procedure

Five-step flow. Step 5 is the escape hatch — use it the moment step
1, 2, or 3 fails to converge.

## 1. Read signals

Read the user's request. Map each signal to one or more components
using the 30-row signal table in
`pi-sandbox/skills/pi-agent-builder/references/reading-short-prompts.md`.
Examples (non-exhaustive — the table is authoritative):

cwd-guard and sandbox-fs are auto-injected — never list them.
The "components" column below shows only the role-specific stubs
you DO list in `components:`; sandbox verbs you put in `tools`
activate sandbox-fs automatically.

| User says… | User-listed component(s) | Sandbox verbs in `tools` |
| --- | --- | --- |
| "summarize", "survey", "audit", "explore", "map out", "index" (no draft step follows) | `emit-summary` | `sandbox_read,sandbox_ls,sandbox_grep,sandbox_glob` |
| "draft a file and show me", "stage, then approve", "preview before writing" | `stage-write` | `sandbox_ls` (or `sandbox_ls,sandbox_read`) |
| "write X into `<dir>`", "no approval needed", batch / scripted run | (none beyond auto-inject) | `sandbox_read,sandbox_write,sandbox_edit,sandbox_ls,sandbox_grep` |
| "look at X, then write Y", "given what's there, produce the missing W" | `emit-summary` (phase 1), `stage-write` (phase 2) | per-phase subset |
| "dispatch several drafters then review", "orchestrator that reviews" | `stage-write`, `review`, `run-deferred-writer` (deferred — emit GAP) | per-spawn |
| "have an LLM check each draft before saving" (single drafter, no fan-out) | `stage-write`, `review` (deferred — emit GAP) | per-spawn |

**Stop early on network I/O.** Asks like "summarize an external API
endpoint" echo the recon signals but require an I/O channel no
component provides — `http`/`https`, websockets, webhooks, remote
APIs, downloads. No component's `--tools` allowlist includes
network verbs, and no component wraps `fetch`/`http` on behalf of a
sub-pi. Emit GAP directly (step 5); do NOT improvise
`node:child_process`, `globalThis.fetch`, or `curl` calls inside
the parent handler — that violates the cardinal "compose, don't
author" rule even when the component shape otherwise matches.

If NO signal maps to any component, go straight to step 5.

## 2. Pick parts

Take the role-specific components implied by step 1's signals.
**Do NOT list `cwd-guard` or `sandbox-fs`** — they are auto-injected
by the runner and listing either name is a validation error.

- The phase's `tools` list determines which sandbox verbs the
  runner activates sandbox-fs with. A recon phase lifts
  `sandbox_read,sandbox_ls,sandbox_grep,sandbox_glob`; a
  drafter-with-approval lifts `sandbox_ls` (writes go via
  `stage_write`); a confined-drafter lifts the read verbs plus
  `sandbox_write,sandbox_edit`; a no-fs delegator lifts nothing
  (sandbox-fs not loaded).
- cwd-guard loads on every spawn unconditionally — it sets
  `PI_SANDBOX_ROOT` and runs the path-arg auditor.
- The built-in `read`/`ls`/`grep`/`glob`/`write`/`edit` are
  forbidden across the project — sandbox-fs's `sandbox_*` family is
  the only sanctioned fs surface.

If a signal points at a component the library doesn't have (e.g.
"open a websocket and stream events"), that's a GAP. Go to step 5.

## 3. Pick composition topology

`compositions.md` names two the YAML composer can emit. Apply this
cascade in order; the first match wins:

```
if run-deferred-writer ∈ components        → GAP (orchestrator deferred)
else if review ∈ components                → GAP (orchestrator deferred)
else if emit-summary ∈ components && stage-write ∈ components
                                           → sequential-phases-with-brief
else                                       → single-spawn
```

The `review` / `run-deferred-writer` branches go straight to step 5
because the YAML runner cannot drive an RPC delegator session —
both `emit_agent_spec` and the runner reject those components. Do
NOT try to express orchestrator shapes in YAML; the gap message
points the user at `pi-agent-builder`, which authors RPC
extensions from primitives.

If neither remaining topology fits the user's ask (e.g. the user
wants a fire-and-forget background drafter with no parent
harvesting), go to step 5.

## 4. Emit the spec

Call `emit_agent_spec` exactly once with the structured fields.
The tool's TypeBox schema IS the YAML spec shape — you cannot
write YAML or TypeScript by hand. The tool writes
`.pi/agents/<name>.yml` **after a user-approval gate**: the
confirm dialog shows the user the full YAML before anything
lands.

If the call returns `isError: true` with `details.cancelled: true`
and `details.reason: "denied"`, the user denied the spec. **Ask
them what they would like to change in natural-language chat,
then re-emit with their reply baked in.** Do NOT silently retry
with a different name or with synthesized "improvements" they
didn't ask for; the user's reply IS the revision instruction.

Once approved, the auto-discovered runner registers `/<slash>` on
the next pi startup and dispatches each phase via `delegate()`.

Phase prompts may use `{args}` (the slash-command argument the
user passes at runtime), `{sandboxRoot}` (absolute path of
pi-sandbox), and — phase 2 of `sequential-phases-with-brief` only
— `{brief}` (assembled from phase-1 `emit_summary` calls).

### Example (single-spawn — covers `[emit-summary]` and `[stage-write]`)

```
emit_agent_spec({
  name: "<filename>",
  slash: "<slash-command-no-leading-/>",
  description: "<one line>",
  composition: "single-spawn",
  phases: [
    {
      components: ["stage-write"],   // ← role-specific stubs only
      tools: ["sandbox_ls", "stage_write"],   // ← sandbox_ls activates sandbox-fs
      prompt: "You are a DRAFTER. Task: {args}. Stage files via stage_write under {sandboxRoot}. Reply DONE when finished."
    }
  ]
})
```

`cwd-guard` and `sandbox-fs` are auto-injected — listing either
name fails validation. The runner activates sandbox-fs because the
`tools` list includes a `sandbox_*` verb; if you omit all sandbox
verbs the role becomes no-fs (e.g. an emit-summary-only flow with
no read access — uncommon but allowed). The runner's `delegate()`
calls infer the model tier automatically — `$TASK_MODEL` here
because neither `review` nor `run-deferred-writer` are present.

### Example (sequential-phases-with-brief — recon → draft)

```
emit_agent_spec({
  name: "<filename>",
  slash: "<slash-command>",
  description: "<one line>",
  composition: "sequential-phases-with-brief",
  phases: [
    {
      name: "scout",
      components: ["emit-summary"],
      tools: ["sandbox_ls", "sandbox_read", "sandbox_grep", "sandbox_glob", "emit_summary"],
      prompt: "Survey {args}. Use emit_summary for each finding."
    },
    {
      name: "draft",
      components: ["stage-write"],
      tools: ["sandbox_ls", "stage_write"],
      prompt: "Task: {args}\n\n<brief>\n{brief}\n</brief>\n\nStage missing pieces under {sandboxRoot}. Reply DONE."
    }
  ]
})
```

The runner enforces phase-1 ⊇ `{emit-summary}` and phase-2 ⊇
`{stage-write}` for this composition. Any `{brief}` reference
outside phase 2 of `sequential-phases-with-brief` is left
unsubstituted at runtime.

### orchestrator (deferred — emit GAP)

`emit_agent_spec` rejects any phase containing `review` or
`run-deferred-writer`. The runner cannot drive an RPC delegator
session — that topology stays in `pi-agent-builder`'s scope. If
the user's ask requires fan-out + LLM review, jump to step 5
(GAP) instead of trying to express it in YAML.

## 5. Flag the gap

When step 1 produces no confident match, step 2 reveals a missing
component, step 3 cascades to the orchestrator branch (the YAML
runner doesn't drive RPC), or no topology fits, emit EXACTLY this
message and stop:

```
GAP: I don't have a component for "<user's ask, quoted>".
Components I have: stage-write, emit-summary, review, run-deferred-writer.
Closest match: <"none" OR nearest part/topology + 1-sentence why it doesn't quite fit>.
To cover this you'd need: <one sentence describing the missing part, OR "the YAML composer doesn't cover orchestrator topology yet — load pi-agent-builder">.
To continue anyway, load the pi-agent-builder skill.
```

Do NOT then call `emit_agent_spec`. The gap message is the whole
deliverable. The user will decide whether to reshape the ask into
the existing components or fall back to `pi-agent-builder`.

The `GAP:` header and `I don't have a component` phrase are
byte-identical to the assembler's GAP message. Both graders share
the same regex; do not paraphrase.
