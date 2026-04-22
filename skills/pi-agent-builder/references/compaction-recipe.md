# Compaction recipe

Long sessions exhaust context. Pi's compaction summarizes older messages while keeping recent ones. By default it runs automatically near the context limit (and on overflow) or manually via `/compact`. You can customize it.

## Why customize

Defaults are fine for generic work. You'd customize to:

- Use a cheaper / faster model for summarization (most extensions do this).
- Summarize by topic or file rather than chronologically.
- Preserve specific content (errors, test output, decisions) more aggressively.
- Cancel compaction when the user is in a flow state.

## The hook: `session_before_compact`

```ts
pi.on("session_before_compact", async (event, ctx) => {
  // event.messages — what would be summarized
  // event.customInstructions — user-provided instructions, if any
  // Return nothing → use default compaction
  // Return { cancel: true, reason } → skip compaction
  // Return { summary: "..." } → use your summary instead
});
```

Also useful: `session_compact` fires after compaction completes (observational).

## Pattern 1: custom summarizer model

The default uses the session's current model. Swap to a cheaper one for summaries:

```ts
pi.on("session_before_compact", async (event, ctx) => {
  const summary = await callModel("claude-haiku-4-5", {
    system: "Summarize the following conversation for a coding agent's memory. Preserve: decisions made, errors encountered, files touched. Drop: tool call boilerplate, exploratory reads.",
    messages: event.messages,
  });
  return { summary };
});
```

This can be a 5–10× cost reduction for long sessions.

## Pattern 2: structured summary

Default summaries are prose. Structured summaries often serve the LLM better:

```ts
const summary = `
## Goal
${await inferGoal(event.messages)}

## Files touched
${filesTouched(event.messages).join(", ")}

## Decisions
${decisionsList(event.messages).map((d) => `- ${d}`).join("\n")}

## Open questions
${openQuestions(event.messages).map((q) => `- ${q}`).join("\n")}
`;
return { summary };
```

## Pattern 3: preserve-specific content

Keep errors and test failures at full fidelity; summarize the rest.

```ts
pi.on("session_before_compact", async (event, ctx) => {
  const toPreserve = event.messages.filter(isErrorOrFailure);
  const toSummarize = event.messages.filter((m) => !isErrorOrFailure(m));
  const summary = await callModel("claude-haiku-4-5", {
    system: "Summarize:",
    messages: toSummarize,
  });
  return {
    summary: `${summary}\n\n## Preserved (errors/failures)\n${preservedText(toPreserve)}`,
  };
});
```

## Pattern 4: cancel during flow

```ts
let lastUserActivityMs = Date.now();
pi.on("tool_call", () => { lastUserActivityMs = Date.now(); });

pi.on("session_before_compact", async (event, ctx) => {
  const idleSec = (Date.now() - lastUserActivityMs) / 1000;
  if (idleSec < 5) {
    // User is actively interacting; defer compaction
    return { cancel: true, reason: "User active, deferring compaction" };
  }
});
```

Be careful: pi triggers compaction proactively *and* on context overflow. Cancelling during an overflow causes the next LLM call to fail. Don't blanket-cancel — only defer, and let overflow-triggered compactions proceed.

## Internals worth knowing

From `docs/compaction.md`:

- **Turn boundary**: compaction cuts at turn boundaries (user message → next user message) when possible. A single massive turn forces a mid-turn cut.
- **`firstKeptEntryId`**: the marker for what survives. Later compactions summarize from the previous kept boundary, so preserved messages get re-summarized in subsequent passes.
- **Tool results truncated to 2000 chars** during serialization before summarization. Keeps summary-request tokens reasonable.
- **Session JSONL retains the full history.** Compaction is lossy *for the model*, not for the log. Use `/tree` to revisit.

## Top failure modes

1. **Cancel feedback loop.** Cancelling compaction every time → context overflows → pi errors. Always let overflow-triggered compactions run.
2. **Summary too long.** Your "summary" is larger than what it replaced. Aim for a consistent target (e.g. 1000 tokens) regardless of input size.
3. **Summarizer model hallucinates decisions.** Cheap models invent facts from long contexts. Use structured prompts with explicit "only include things stated literally in the messages."
4. **Dropping critical details.** If a specific file path or error message always matters, extract it with regex before summarization and append verbatim.
