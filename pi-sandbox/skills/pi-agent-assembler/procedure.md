# Assembly procedure

Follow these four steps in order. Step 5 is the escape hatch — use
it the moment step 1 or step 2 fails.

## 1. Classify the prompt

Read the user's request. Match it against the `patterns/` catalog
using these signals (kept terse — the pattern files carry worked
examples):

| User says… | Pattern |
| --- | --- |
| "summarize", "read", "survey", "what's in", "audit", "explore", "map out", "index" (and no draft / write step follows) | `recon` |
| "write X for me — I want to review before it saves", "draft a file and show me", "stage, then approve", "preview before writing" | `drafter-with-approval` |
| "write X into `<dir>`", "generate a file", "create a project at", "no approval needed", batch / scripted run | `confined-drafter` |
| "look at X, then write Y", "survey the project and add a Z", "given what's there, produce the missing W", "read the directory and generate a README summarizing it" | `scout-then-draft` |
| "break this into sub-tasks and have an LLM check each", "dispatch several drafters then review", "orchestrator that reviews" | `orchestrator` |

A confident match = the user's prompt contains at least one signal
from the pattern's "when to use" sentence (see each pattern's
top-of-file paragraph).

If multiple patterns match, prefer the **simpler** one (`recon` <
`confined-drafter` < `drafter-with-approval` < `scout-then-draft` <
`orchestrator`). Only promote to `scout-then-draft` when both a
survey AND a draft step appear in the ask; only promote to
`orchestrator` when the user explicitly mentions multiple sub-tasks
or LLM review.

**Stop early on network I/O.** Some asks read superficially like a
pattern (e.g. "summarize an external API endpoint" echoes recon's
"summarize", "audit") but require an I/O channel no pattern's child
has — `http`/`https`, websockets, webhooks, remote APIs, downloads.
No pattern's `--tools` allowlist includes network verbs, and no
component wraps `fetch`/`http` on behalf of a sub-pi. Emit GAP
directly (step 5); do NOT improvise `node:child_process`,
`globalThis.fetch`, or `curl` calls inside the parent handler — that
violates the cardinal "compose, don't author" rule even when the
pattern shape otherwise matches.

If NO pattern matches, go straight to step 5.

## 2. Pick parts

Every pattern's `## Parts` section lists exactly which
`pi-sandbox/.pi/components/<n>.ts` files the generated extension
loads into child pi processes. Use that list verbatim.

**Required invariant:** every pattern except `recon` starts with
`cwd-guard.ts`. `recon` skips it because the child has no write
channel at all — its `--tools` allowlist is read-only.

If the pattern's parts list doesn't cover what the user's prompt
needs (e.g. the user wants a staged-write drafter that ALSO needs
bash or http access inside the sandbox), that's a GAP. Go to step 5.

## 3. Emit glue

Copy the pattern's skeleton (the fenced `ts` block under its
`## Skeleton` heading) verbatim. Fill in the TODO-marked slots from
the user's prompt:

- `TODO:CMD_NAME` — slug for `registerCommand`.
- `TODO:CMD_DESCRIPTION` — one-line description for the slash
  command.
- `TODO:AGENT_PROMPT` — the prompt you send to the child pi. Keep
  the rails the pattern already has (no-write-built-in note,
  path-relative-to-sandbox note) and append task-specific guidance.
- `TODO:VALIDATION` — task-specific post-processing on harvested
  data. Leave as the default if the task has no extra checks.

**Do not rename variables, remove safety rails, or change the
spawn args.** Pattern skeletons encode the always-on rails from
`pi-agent-builder/references/defaults.md` (stdio: "ignore", SIGKILL
timeout, progress notifies at every tool-call boundary,
sandbox-root check, promotion caps). Drift here re-introduces bugs
the patterns were written to prevent.

## 4. Verify the checklist

Every pattern's `## Validation checklist` lists concrete anchors the
generated extension must contain:

- **Output path starts with `.pi/extensions/`.** Not `./<name>.ts`,
  not `<name>.ts` at cwd root. Pi only auto-discovers from
  `.pi/extensions/`; a file in the root directory is invisible to
  the harness.
- `-e <abs path to cwd-guard.ts>` on every spawn (not recon).
- `PI_SANDBOX_ROOT` set in the child's env.
- `--no-extensions` on every spawn.
- `--tools <allowlist>` matching the pattern (no `write`, no
  `edit`, no `bash` unless the pattern includes them).
- A `setTimeout` + `child.kill("SIGKILL")` hard cap on each phase.
- A `process.env.TASK_MODEL` / `$PLAN_MODEL` / `$LEAD_MODEL` pick
  that matches the role (`patterns/*.md` specify which tier).

Run through the checklist before handing the extension back to the
user. If any item is missing, the skeleton wasn't copied faithfully
— re-emit from the pattern.

## 5. Flag the gap

When step 1 produces no confident match, or step 2 reveals a part
the library doesn't have, emit EXACTLY this message and stop:

```
GAP: I don't have a component for "<user's ask, quoted>".
Patterns I know: recon, drafter-with-approval, confined-drafter, orchestrator.
Closest match: <"none" OR the nearest pattern name + 1-sentence why it doesn't quite fit>.
To cover this you'd need: <one sentence describing the missing part or pattern>.
To continue anyway, load the pi-agent-builder skill for from-scratch authorship.
```

Do NOT then go on to write an extension. The gap message is the
whole deliverable. The user will decide whether to reshape the ask
into an existing pattern or fall back to `pi-agent-builder`.

The gap message is the single most load-bearing contract of this
skill. Improvising past it defeats the entire reason the skill
exists — if you're unsure, emit the GAP.
