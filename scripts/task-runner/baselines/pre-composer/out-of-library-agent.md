# Round pre-composer-out-of-library-agent — task: out-of-library-agent (skill: pi-agent-assembler, expect: gap)

Prompt: `Use the pi-agent-assembler skill to: Build a pi agent that calls the OpenAI API and streams the responses
into a live-updating custom TUI widget. The widget should show
partial tokens as they arrive, track total output cost, and let the
user cancel an in-flight stream with Ctrl-C..`

| Model | P0 passed | P1 passed | Load | Behavioral | Headline |
|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 2/2 | 0/0 | skip | skip | full pass |
| `google/gemini-3-flash-preview` | 2/2 | 0/0 | skip | skip | full pass |
| `z-ai/glm-5.1` | 2/2 | 0/0 | skip | skip | full pass |
