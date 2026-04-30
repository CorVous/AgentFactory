# Repo layout

- `package.json` — ESM project, pins `@mariozechner/pi-coding-agent`.
  Defines `npm run pi` (raw pi from `pi-sandbox/`) and `npm run agent`
  (recipe-driven runner).
- `models.env` — tier → model-ID mapping. See [model-tiers.md](./model-tiers.md).
- `scripts/run-agent.mjs` — recipe runner used by `npm run agent`.
- `AGENTS.md` / `CLAUDE.md` — thin index files at repo root. **Not** loaded
  into pi sessions (`npm run pi` and `npm run agent` both pass `-nc`).
- `docs/` — this folder. Long-form docs split out of `AGENTS.md`.
- `pi-sandbox/` — pi's content lives here.
  - `pi-sandbox/agents/` — YAML recipes consumed by `npm run agent`.
    - `pi-sandbox/agents/deferred/` — recipes for the deferred-* mutation stack
      (`deferred-writer`, `deferred-author`, `writer-foreman`, `delegator`,
      `peer-chatter`, `mesh-*`). Use `deferred/<name>` as the recipe name.
  - `pi-sandbox/.pi/extensions/` — project-local pi extensions.
    - `pi-sandbox/.pi/extensions/deferred/` — extensions for the deferred-* stack:
      `sandbox`, `no-edit`, `atomic-delegate`, `deferred-write`, `deferred-edit`,
      `deferred-move`, `deferred-delete`, `deferred-confirm`. Use `deferred/<name>`
      in recipe `extensions:` lists; the runner resolves subdirectory-qualified names.
    - `pi-sandbox/.pi/extensions/_lib/` — shared TypeScript helpers (bus, habitat,
      supervisor-inbox, etc.); never moved.
  - `pi-sandbox/.pi/scratch/` — throwaway prompt files, raw pi output,
    anything you don't want to check in. Gitignored.
  - `pi-sandbox/skills/pi-agent-builder/` — pi skill that teaches pi how
    to build agents.

## Workflow

- **Build pi extensions by having pi build them.** The preferred path is
  `npm run pi -- --skill skills/pi-agent-builder -p "<short description>"`
  (or via `@.pi/scratch/prompt.md` for longer asks). The `pi-agent-builder`
  skill is written for pi to consume, not for Claude or any other harness
  to read on its behalf.
- **Short natural-language prompts are the norm.** If a short prompt
  produces an incorrect or unsafe extension, the fix is to refine the
  skill — add the missing signal to
  `pi-sandbox/skills/pi-agent-builder/references/reading-short-prompts.md`
  or the missing rail to `.../references/defaults.md` — rather than
  padding every prompt with a full technical spec.
- **Scratch artifacts live in `pi-sandbox/.pi/scratch/`** (gitignored).
  Raw pi output, throwaway prompt files, and experiments go there and
  stay out of the tracked tree.
