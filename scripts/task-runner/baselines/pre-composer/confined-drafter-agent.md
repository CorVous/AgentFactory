# Round pre-composer-confined-drafter-agent — task: confined-drafter-agent (skill: pi-agent-assembler, expect: assembly: confined-drafter)

Prompt: `Use the pi-agent-assembler skill to: Write me an agent that takes a task description and creates a new
TypeScript file implementing it. The agent should write the file
directly into a sandboxed directory — no approval gate needed, it's
for scripted batch runs..`

| Model | P0 passed | P1 passed | Load | Behavioral | Headline |
|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 19/19 | 1/1 | pass | pass | full pass |
| `google/gemini-3-flash-preview` | 19/19 | 1/1 | pass | pass | full pass |
| `z-ai/glm-5.1` | 19/19 | 1/1 | pass | pass | full pass |
