# prompts-seen.md

A collection log for real "I want a pi agent that …" asks encountered in
the wild. Maintained as a parallel track to the reverse pipeline
(`scripts/reverse-pipeline/`): the pipeline stress-tests the classifier
on synthetic paraphrases; this log records the *actual* distribution of
user asks the assembler has to handle.

## Format

Each entry is a short block:

```
- kind: fits-existing | gap
  source: <conversation id | issue URL | "synthetic">
  closest-pattern: <pattern-name | "none">
  request: |
    <verbatim or lightly-edited user ask>
  notes: <one-line observation, especially for gap asks>
```

## Intended use

1. **Population.** Add asks as they come up. 20–30 entries is a useful
   working set. Synthetic entries (developer chores the library should
   plausibly cover) are fine but should be labelled `source: synthetic`.
2. **Triage.** When three or more independent `kind: gap` entries cluster
   around the same missing capability (e.g. "http fetch", "approval gate
   with timeout"), that cluster is a candidate new component. Author it
   via `pi-agent-builder` under `pi-sandbox/.pi/components/<name>.ts`.
3. **Seeding.** The reverse pipeline's `gap-seeds.ts` is hand-maintained;
   copy confirmed-gap requests from here as new seeds when they represent
   shapes the current seeds don't cover.

## Entries

<!-- Populate as real asks come in. Synthetic entries are fine; tag
them `source: synthetic-<round>` so triage can tell them apart from
real user asks. -->

- kind: gap
  source: synthetic-gap-matrix-2026-04-24
  closest-pattern: none
  request: |
    I want an agent that can execute arbitrary bash commands on my
    local system based on my natural language instructions. It should
    be able to run complex shell scripts, manage system processes, and
    report back the specific exit codes and command outputs.
  notes: Gemini + glm gap correctly; haiku emits a non-normalized GAP header (grader p0 1/2). Explicitly out-of-scope for the assembler per the cardinal rule against bash child-tools.

- kind: gap
  source: synthetic-gap-matrix-2026-04-24
  closest-pattern: recon
  request: |
    I want an agent that can fetch live data from a specified URL over
    HTTP. It should be able to parse the JSON response and provide a
    concise summary of the key fields.
  notes: Most valuable classifier signal in this round. Gemini gapped correctly; haiku improvised an http-fetch recon variant with inline `node:child_process` (violates "don't invent new parts"); glm-5.1 dropped a stray `http-poll.ts` and produced a 994 MB events.ndjson that crashed the grader. Candidate follow-up — add an explicit "http/network I/O" negative signal in `procedure.md` step 1.

- kind: gap
  source: synthetic-gap-matrix-2026-04-24
  closest-pattern: none
  request: |
    I want an agent that maintains a persistent interactive chat session
    across multiple separate executions. Remembers the full context and
    history across process restarts so I can pick up where I left off.
  notes: All three models route to GAP. Procedure.md already lists "session-persistence work" as a pi-agent-builder fallback; classifier uses that signal correctly.

- kind: gap
  source: synthetic-gap-matrix-2026-04-24
  closest-pattern: none
  request: |
    I want an agent that runs on a recurring cron schedule to monitor a
    specific local log file. Tails for stack traces or error keywords
    and sends an alert if it detects a spike over a time window.
  notes: All three GAP correctly. Closest-match disagrees across models (haiku=confined-drafter, gemini=none, glm=recon) — informational, not a grading concern.

- kind: gap
  source: synthetic-gap-matrix-2026-04-24
  closest-pattern: none
  request: |
    I want an agent that provides a live-updating TUI dashboard for
    monitoring LLM generations. Stream model responses into a custom
    widget in real-time with an interactive cancel button.
  notes: All three GAP correctly. Custom-TUI-widget work is another documented pi-agent-builder fallback; classifier uses that signal correctly.

- kind: gap
  source: synthetic-gap-matrix-2026-04-24
  closest-pattern: recon
  request: |
    I want an agent that performs a rigorous dual-pass evaluation of my
    existing source code files without making any changes to them.
    Provides a detailed critique and quality score for each file.
    Strictly a reviewer; never rewrites or fixes.
  notes: Classifier routes all three models to recon + emit-summary — correctly. `emit-summary` IS the finding-report channel; the seed's "no summary emission; pure reviewer role without a component" over-narrows. This seed is likely mislabeled as gap and should be dropped or revised. Triage-only for this branch.
