# Round phase2-post-composer-recon — task: composer-recon (skill: pi-agent-composer, expect: composition)

Prompt: `Use the pi-agent-composer skill to: Write me an agent that reads a directory and produces a one-page
summary of what it contains..`

| Model | P0 passed | P1 passed | Load | Behavioral | Headline |
|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 10/11 | 2/2 | pass | partial | mostly passing |
| `google/gemini-3-flash-preview` | 10/11 | 2/2 | partial | partial | mostly passing |
| `z-ai/glm-5.1` | 10/11 | 2/2 | partial | partial | mostly passing |
