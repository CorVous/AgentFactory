# Skills, context files, and prompt templates

Pi has its own skills system, distinct from Claude skills. An extension author needs to know about it because:

- Skills, context files, and prompt templates often solve problems extensions don't need to.
- An extension can install or interact with them.
- Users install *pi packages* that mix all four (extensions, skills, prompts, themes).

## Pi skills — what they are

A pi skill is a capability package loaded on-demand. Skills live at `~/.pi/agent/skills/<skill-name>/` or within a pi package. Each skill has a `SKILL.md` with instructions the agent reads when relevant, plus optional scripts and assets.

This is *progressive disclosure* — the skill metadata (name, description) is always in context, but the body loads only when the agent decides to consult it. Same pattern as Claude skills in `/mnt/skills/`, though the file layout and frontmatter differ.

Key points:

- **When to use a skill vs an extension**: skills are *instructions for the model*. Extensions are *TypeScript code*. If the need is "teach the agent how to do X via prompting," use a skill. If the need is "add new tool, intercept event, integrate an external service," use an extension.
- **Skills can be bundled with extensions in the same pi package** — the skill instructs the model on when and how to call the extension's tools.

## AGENTS.md (or CLAUDE.md)

Project-level system-prompt fragments, loaded at startup. Pi reads from:

- `~/.pi/agent/AGENTS.md` — global
- Parent directories' `AGENTS.md` — walked up from cwd
- Current directory's `AGENTS.md`

All concatenated. Good for:

- Project conventions (commit message format, naming rules)
- Common commands (`npm test`, `pnpm dev`)
- Known gotchas ("the database migrations are flaky; always run twice")
- Directory-specific rules (deep in a monorepo)

Prefer this over an extension when the information is static. An extension is overkill for "remind the agent about our commit conventions."

## SYSTEM.md

Replaces or appends to pi's default system prompt, per-project. Heavier hammer than AGENTS.md. Reach for it when:

- You want a completely different persona for a specific project.
- You want to strip default behaviors you don't need.
- You're running pi as a specialized assistant (e.g. a docs writer) rather than a general coder.

## Prompt templates

Reusable prompts stored as markdown files. User types `/name` in the TUI and pi expands the template into the input. Great for:

- Starting a new feature (`/new-feature` expands to a checklist prompt)
- Code review (`/review` expands to a detailed review prompt with criteria)
- Bug intake (`/bug` expands to a structured bug-report prompt)

Templates live at `~/.pi/agent/prompts/<n>.md` or within a pi package. They can reference variables the user fills in.

## When an extension author cares

Three scenarios where skills/AGENTS.md/templates matter during extension development:

1. **Documenting your extension to the model.** Ship a skill alongside your extension in the pi package. The skill's `SKILL.md` tells the agent when to use your tools and in what order. This is often more effective than trying to cram all the usage guidance into a single tool `description`.

2. **Registering context files.** An extension can read AGENTS.md and inject project-specific state it computes. Example: your extension reads AGENTS.md, parses a "dependencies" section, and injects current versions via the `context` event.

3. **Creating templates programmatically.** An extension can write prompt templates to `~/.pi/agent/prompts/` on `session_start`, effectively teaching the user shortcuts that match the extension's capabilities.

## The combined pattern: a pi package with all four

A mature pi package often includes:

```
my-pi-package/
├── agent/
│   ├── extensions/ci-tools.ts         # Tools: run_ci, fetch_logs
│   ├── skills/ci-workflow/SKILL.md    # When to use run_ci vs fetch_logs, common flows
│   ├── prompts/triage-failure.md      # /triage-failure → expanded prompt
│   └── themes/ci-dark.json            # Color scheme matching the tool's status
```

Each piece reinforces the others. Extensions provide capability. Skills provide know-how. Prompts provide user shortcuts. Themes provide polish.

## Quick rules of thumb

- **Static project info** → AGENTS.md.
- **Instructions on how to use tools** → skill.
- **New capability / integration** → extension.
- **User-invoked boilerplate prompt** → prompt template.
- **Change the agent's whole personality** → SYSTEM.md.
