# Round phase2-post-composer-out-of-library — task: composer-out-of-library (skill: pi-agent-composer, expect: gap)

Prompt: `Use the pi-agent-composer skill to: Build a pi agent that calls the OpenAI API and streams the responses
into a live-updating custom TUI widget. The widget should show
partial tokens as they arrive, track total output cost, and let the
user cancel an in-flight stream with Ctrl-C..`

| Model | P0 passed | P1 passed | Load | Behavioral | Headline |
|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 2/2 | 0/0 | skip | skip | full pass |
| `google/gemini-3-flash-preview` | 1/2 | 0/0 | skip | skip | mostly passing |
| `z-ai/glm-5.1` | 0/2 | 0/0 | skip | skip | major misses |
