# Checklists

After the loop exits and the final integration smoke runs, produce two checklists. Both are written by the orchestrator (not a subagent) and saved to `RALPH_QA.md` at the repo root.

At the time the human reads `RALPH_QA.md`, every issue listed is still **open** — issues only get closed after the human merges the round's PR and runs the close-out agent ([close.md](close.md)). The checklist file should remind the human of this at the top.

## What goes on a human checklist

Only items that **require human judgement or human senses**. Specifically:

- Visual / UX behaviour (does it look right, does the animation feel right, is the empty state friendly)
- Real third-party integrations that can't be safely automated (production payment provider, real OAuth flow, sending real emails)
- Multi-user or multi-device flows that the test suite stubs out
- Perceived performance — "does it feel fast"
- Copy, tone, accessibility wording, error message clarity
- End-to-end journeys that cross deployment boundaries

## What does NOT go on a human checklist

If a check is mechanical, it belongs inside the loop, not on a human's plate. Specifically, **never** put any of these on the checklist:

- "Search for `console.log`" — the agents grep for that themselves
- "Check there are no `TODO` comments" — grep
- "Verify the function is called from the right place" — grep
- "Confirm types compile" — typecheck
- "Confirm tests pass" — already ran
- "Check for `any` casts" — grep
- "Check imports are sorted" — formatter / lint

If, while drafting the checklist, you write an item that a `grep`, a `tsc --noEmit`, a test run, or a linter could answer — delete it and add that check to the relevant subagent prompt instead. The human checklist is the wrong place to catch mechanical regressions.

## Required format

Both checklists use the same format. Every item cites both:

1. The **issue id** that introduced the requirement
2. The **merge commit SHA** that brought it in (the merge agent reported these in its final message)

```markdown
# Ralph QA Checklist — Round {N} merged into {source_branch}

Final integration smoke: ✅ passed | ❌ failed (see notes below)

> Issues below are still open. After you merge the round's PR, run the close-out agent (`close.md`) to close them with commit references.

## Human QA

- [ ] Empty cart state shows the new illustration and the "Browse" CTA — issue #142, commit a1b2c3d
- [ ] Magic-link email actually arrives in a real inbox within 30 seconds — issue #156, commit e4f5g6h
- [ ] Two users editing the same document see each other's cursor within ~200ms — issue #161, commit i7j8k9l

## Code review (optional)

- [ ] The new `BillingProvider` interface looks like the right boundary long-term — issue #142, commit a1b2c3d
- [ ] Token-rotation flow in `auth/refresh.ts` is correct under concurrent refresh — issue #156, commit e4f5g6h
```

## Drafting rules

When generating the checklists:

- **One item per acceptance criterion** that survives the "is this mechanical?" test above. Group items by issue.
- **No duplicates across the two lists.** If an item belongs on Human QA, don't also put it on Code Review.
- **Skip the Code Review section entirely** if every change is small, mechanical, or already well-covered by tests. An empty optional checklist is better than padding.
- **Surface failures first.** If the final integration smoke failed, the first Human QA item is "Investigate failed integration smoke: \<failure summary\>" with a link to the failing test.
- **Write each item as a verifiable action**, not a question. "Confirm the export button downloads a CSV" — not "does the export button work?"
