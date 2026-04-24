# Round phase2-baseline-composer-confined-drafter — task: composer-confined-drafter (skill: pi-agent-composer, expect: composition)

Prompt: `Use the pi-agent-composer skill to: Write me an agent that takes a task description and creates a new
TypeScript file implementing it. The agent should write the file
directly into a sandboxed directory — no approval gate needed, it's
for scripted batch runs..`

| Model | P0 passed | P1 passed | Load | Behavioral | Headline |
|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 16/17 | 1/1 | pass | pass | mostly passing |
| `google/gemini-3-flash-preview` | 16/17 | 1/1 | pass | pass | mostly passing |
| `z-ai/glm-5.1` | 17/17 | 1/1 | pass | pass | full pass |
