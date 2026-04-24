# Round recompose-2026-04-24-composer-full-orchestrator — task: composer-full-orchestrator (skill: pi-agent-composer, expect: composition)

Prompt: `Use the pi-agent-composer skill to: Build me an orchestrator agent that can dispatch several drafter
children in parallel to produce staged drafts, have an LLM reviewer
approve or revise each one, and only promote approved drafts to
disk..`

| Model | P0 passed | P1 passed | Load | Behavioral | Headline |
|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 25/26 | 2/2 | fail | skip | mostly passing |
| `google/gemini-3-flash-preview` | 20/25 | 2/2 | partial | pass | mostly passing |
| `z-ai/glm-5.1` | 20/25 | 2/2 | pass | pass | mostly passing |
