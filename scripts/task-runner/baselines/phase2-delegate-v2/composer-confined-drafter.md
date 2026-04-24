# Round recompose-2026-04-24-composer-confined-drafter — task: composer-confined-drafter (skill: pi-agent-composer, expect: composition)

Prompt: `Use the pi-agent-composer skill to: Write me an agent that takes a task description and creates a new
TypeScript file implementing it. The agent should write the file
directly into a sandboxed directory — no approval gate needed, it's
for scripted batch runs..`

| Model | P0 passed | P1 passed | Load | Behavioral | Headline |
|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 10/11 | 2/2 | pass | pass | mostly passing |
| `google/gemini-3-flash-preview` | 10/11 | 2/2 | pass | pass | mostly passing |
| `z-ai/glm-5.1` | 10/11 | 2/2 | pass | pass | mostly passing |
