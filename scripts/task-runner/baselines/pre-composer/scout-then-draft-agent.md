# Round pre-composer-scout-then-draft-agent — task: scout-then-draft-agent (skill: pi-agent-assembler, expect: assembly: scout-then-draft)

Prompt: `Use the pi-agent-assembler skill to: Build me an agent that surveys a directory, then drafts a new
README.md summarizing what's there. Show me the draft before saving..`

| Model | P0 passed | P1 passed | Load | Behavioral | Headline |
|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 21/22 | 1/1 | partial | pass | mostly passing |
| `google/gemini-3-flash-preview` | 22/22 | 1/1 | partial | pass | mostly passing |
| `z-ai/glm-5.1` | 22/22 | 1/1 | pass | pass | full pass |
