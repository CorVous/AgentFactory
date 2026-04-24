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

<!-- Populate as real asks come in. -->
