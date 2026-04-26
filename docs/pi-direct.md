# Using pi directly

`npm run agent` is the default entry point for focused agents. Use the
direct paths below when you need raw pi (interactive exploration, building
new extensions, or scripting).

## Launching pi

Pi always runs from `pi-sandbox/` — its extensions, sessions, and scratch
files live there. The `npm run pi` script handles the `cd` for you and
also passes `--no-context-files` so the outer `AGENTS.md`/`CLAUDE.md`
(which are *human* docs about this repo) don't leak into pi's context.

- `npm run pi` — interactive pi session in the sandbox.
- `npm run pi -- -p "..."` — non-interactive. Forward any extra pi
  flags after the `--`.
- `npx pi --help` — full flag reference (`-e` for extensions, `--skill`
  for skills, `-p` for non-interactive, `--mode json` for streaming
  events, `-nc` / `--no-context-files` to suppress AGENTS.md/CLAUDE.md).

Dependencies live in `node_modules/` at the repo root; run `npm install`
after cloning. Invoking pi directly (`npx pi`) from the repo root is not
recommended — it runs outside the sandbox and will pick up the outer
docs as context.

## Creating pi agents the long way

When the recipe-based runner isn't enough — e.g. you're building a brand
new extension or a multi-process pipeline — fall back to invoking pi
directly with the bundled `pi-agent-builder` skill. Pi reads the skill
on demand and generates extensions that follow its recipes.

```sh
set -a; source models.env; set +a
npm run pi -- --provider openrouter --model "$LEAD_HARE_MODEL" \
  --skill skills/pi-agent-builder \
  -p "Use the pi-agent-builder skill to <describe the agent>."
```

Paths (`skills/pi-agent-builder`, `.pi/extensions/…`, `@prompt.md`) resolve
from `pi-sandbox/` cwd, since `npm run pi` cds in.

For prompts with lots of nested quotes, put the prompt in a file under
`.pi/scratch/` and pass `@.pi/scratch/prompt.md` — cleaner than escaping
inline `-p "..."`.

## Scripted (non-interactive) pi invocations

Gotchas we've hit when calling `pi -p` from scripts:

- **Text mode buffers stdout.** The default `--mode text` emits nothing until
  the run completes, so progress (and hangs) are invisible. Use
  `--mode json` — it streams NDJSON events line by line (`turn_start`,
  `tool_execution_start`/`_end`, `message_update`, `agent_end`, etc.).
- **Idle tools invite exploration loops.** With the default tool set and a
  coding-agent system prompt, many models spontaneously run `bash`/`read`
  even for trivial prompts, burning turns and minutes. Always either
  `--no-tools` (pure completion) or `--tools <allowlist>` sized to the job.
- **`timeout` doesn't reach pi through `npm exec`.** SIGTERM kills the
  wrapper but the grandchild `pi` keeps running. If you need a hard ceiling,
  also kill the surviving `pi` PID explicitly.

Recommended scripted pattern:

```sh
npm run pi -- --mode json --no-tools \
  --provider openrouter --model "$TASK_RABBIT_MODEL" \
  --no-session --no-skills --no-extensions \
  -p "$prompt" \
  | jq -c 'select(.type | IN("tool_execution_start","turn_end","agent_end"))'
```
