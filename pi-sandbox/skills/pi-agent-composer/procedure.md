# Composition procedure

Five-step flow. Step 5 is the escape hatch — use it the moment step
1, 2, or 3 fails to converge.

## 1. Read signals

Read the user's request. Map each signal to one or more components
using the 30-row signal table in
`pi-sandbox/skills/pi-agent-builder/references/reading-short-prompts.md`.
Examples (non-exhaustive — the table is authoritative):

| User says… | Implies component(s) |
| --- | --- |
| "summarize", "survey", "audit", "explore", "map out", "index" (no draft step follows) | `emit-summary` |
| "draft a file and show me", "stage, then approve", "preview before writing" | `cwd-guard`, `stage-write` |
| "write X into `<dir>`", "no approval needed", batch / scripted run | `cwd-guard` |
| "look at X, then write Y", "given what's there, produce the missing W" | `cwd-guard`, `emit-summary`, `stage-write` |
| "dispatch several drafters then review", "orchestrator that reviews" | `cwd-guard`, `stage-write`, `review`, `run-deferred-writer` |
| "have an LLM check each draft before saving" (single drafter, no fan-out) | `cwd-guard`, `stage-write`, `review` |

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

Take the union of components implied by step 1's signals. Then
apply the implicit-`cwd-guard` rule:

- If the set contains any write-capable part (`stage-write`, or any
  spawn that loads `cwd-guard.ts` for `sandbox_write`/`sandbox_edit`),
  add `cwd-guard` to the set.
- If the set contains only `emit-summary` (read-only child), do NOT
  add `cwd-guard` — it's redundant and the rails grader will flag
  the child's allowlist as wider than necessary.

If a signal points at a component the library doesn't have (e.g.
"open a websocket and stream events"), that's a GAP. Go to step 5.

## 3. Pick composition topology

`compositions.md` names three. Apply this cascade in order; the
first match wins:

```
if run-deferred-writer ∈ components        → rpc-delegator-over-concurrent-drafters
else if review ∈ components                → rpc-delegator-over-concurrent-drafters
else if emit-summary ∈ components && stage-write ∈ components
                                           → sequential-phases-with-brief
else                                       → single-spawn
```

The `review`-before-emit-summary+stage-write ordering matters:
without it, a `[cwd-guard, stage-write, review]` set (single
drafter + LLM review, no RPC delegator, no fan-out) gets
mis-inferred as `sequential-phases-with-brief`. Reviewing a single
drafter's output is still RPC-delegator topology — the delegator
just dispatches one drafter and reviews one draft.

If none of the three topologies fits the user's ask (e.g. the user
wants a fire-and-forget background drafter with no parent
harvesting), go to step 5.

## 4. Wire it

For each component in the set, follow the **Parent-side wiring
template** in `parts/<name>.md`. Apply every rail in `rails.md`
(the grader asserts each one). Output goes to
`.pi/extensions/<name>.ts`.

The wiring templates are not skeletons — they are per-component
fragments (event anchor, args destructuring, accumulator shape,
finalize behavior) that the composer assembles into a single
extension based on the chosen topology. The canonical references
named in `compositions.md` show how the fragments combine for each
topology.

## 5. Flag the gap

When step 1 produces no confident match, step 2 reveals a missing
component, or step 3 has no fitting topology, emit EXACTLY this
message and stop:

```
GAP: I don't have a component for "<user's ask, quoted>".
Components I have: cwd-guard, stage-write, emit-summary, review, run-deferred-writer.
Closest match: <"none" OR nearest part/topology + 1-sentence why it doesn't quite fit>.
To cover this you'd need: <one sentence describing the missing part>.
To continue anyway, load the pi-agent-builder skill.
```

Do NOT then go on to write an extension. The gap message is the
whole deliverable. The user will decide whether to reshape the ask
into the existing components or fall back to `pi-agent-builder`.

The `GAP:` header and `I don't have a component` phrase are
byte-identical to the assembler's GAP message. Both graders share
the same regex; do not paraphrase.
