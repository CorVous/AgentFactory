# Round phase2-baseline-composer-recon — task: composer-recon (skill: pi-agent-composer, expect: composition)

Prompt: `Use the pi-agent-composer skill to: Write me an agent that reads a directory and produces a one-page
summary of what it contains..`

| Model | P0 passed | P1 passed | Load | Behavioral | Headline |
|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 16/18 | 1/1 | fail | skip | mostly passing |
| `google/gemini-3-flash-preview` | 15/18 | 1/1 | pass | partial | mostly passing |
| `z-ai/glm-5.1` | 18/18 | 1/1 | pass | partial | mostly passing |
