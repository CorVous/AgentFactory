# Round pre-composer-recon-agent — task: recon-agent (skill: pi-agent-assembler, expect: assembly: recon)

Prompt: `Use the pi-agent-assembler skill to: Write me an agent that reads a directory and produces a one-page
summary of what it contains..`

| Model | P0 passed | P1 passed | Load | Behavioral | Headline |
|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 20/20 | 1/1 | pass | partial | mostly passing |
| `google/gemini-3-flash-preview` | 20/20 | 1/1 | partial | partial | mostly passing |
| `z-ai/glm-5.1` | 20/20 | 1/1 | pass | pass | full pass |
