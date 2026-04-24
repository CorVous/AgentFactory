# Round phase2-baseline-composer-scout-then-draft — task: composer-scout-then-draft (skill: pi-agent-composer, expect: composition)

Prompt: `Use the pi-agent-composer skill to: Build me an agent that surveys a directory, then drafts a new
README.md summarizing what's there. Show me the draft before saving..`

| Model | P0 passed | P1 passed | Load | Behavioral | Headline |
|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 24/25 | 2/2 | pass | pass | mostly passing |
| `google/gemini-3-flash-preview` | 24/25 | 2/2 | pass | pass | mostly passing |
| `z-ai/glm-5.1` | 24/25 | 2/2 | pass | pass | mostly passing |
