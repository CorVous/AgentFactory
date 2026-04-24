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

Emit a thin extension at `.pi/extensions/<name>.ts` that imports
the declared components' `parentSide` values and calls the
`delegate()` runtime from `../lib/delegate.ts`. `delegate()` owns
every subprocess rail (spawn frame, NDJSON loop, timeout, cost,
path validation, confirm/promote per rails.md §10) so the
extension body collapses to the slash-command registration and a
single `delegate()` call.

### Template (single-spawn — covers `[emit-summary]`,
### `[cwd-guard]`, `[cwd-guard, stage-write]`)

```ts
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parentSide as CWD_GUARD } from "../components/cwd-guard.ts";
import { parentSide as STAGE_WRITE } from "../components/stage-write.ts";
import { delegate } from "../lib/delegate.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("<slug>", {
    description: "<short description>",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /<slug> <task>", "warning");
        return;
      }
      const sandboxRoot = path.resolve(process.cwd());
      const prompt = `<agent instructions referencing ${sandboxRoot}>`;
      await delegate(ctx, {
        components: [CWD_GUARD, STAGE_WRITE],  // ← declared set
        prompt,
      });
    },
  });
}
```

Substitute the `components` array for the declared component set.
Drop `CWD_GUARD` from both the import and the array when the set
is `[emit-summary]` (read-only recon, no write channel). The
`delegate()` call's tier inference picks `$TASK_MODEL` or
`$LEAD_MODEL` automatically based on whether `review` or
`run-deferred-writer` are in the set — no `--model` override
needed in the composer's output.

### Template (sequential-phases-with-brief — covers
### `[cwd-guard, emit-summary, stage-write]`)

Two `delegate()` calls. Harvest phase-1 summaries from
`byComponent.get("emit-summary")`, assemble into a brief with a
bounded byte-length, and interpolate into phase-2's prompt.

```ts
const scout = await delegate(ctx, {
  components: [EMIT_SUMMARY],           // read-only scout, no CWD_GUARD
  prompt: `Survey ${target}. Use emit_summary for each finding.`,
});
const summaries =
  (scout.byComponent.get("emit-summary") as { summaries: { title: string; body: string }[] } | undefined)
    ?.summaries ?? [];
const brief = summaries.map((s) => `## ${s.title}\n${s.body}`).join("\n\n");
if (Buffer.byteLength(brief, "utf8") > 16_000) {
  ctx.ui.notify("brief exceeds budget; aborting", "error");
  return;
}
await delegate(ctx, {
  components: [CWD_GUARD, STAGE_WRITE],
  prompt: `${userTask}\n\n<brief>\n${brief}\n</brief>`,
});
```

### rpc-delegator-over-concurrent-drafters

Does NOT use `delegate()` for the delegator spawn — `delegate()` is
json-mode only, the delegator needs `--mode rpc` with a persistent
stdin channel driven through multiple phases. The drafter spawns
inside the orchestrator's `Promise.all` DO go through
`delegate(autoPromote: false)`; after review, promotion uses the
exported `promote()` helper. Reference
`pi-sandbox/.pi/extensions/delegated-writer.ts` for the whole
shape; this composer emits a copy-adapted skeleton of it.

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
