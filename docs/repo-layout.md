# Repo layout

- `package.json` — ESM project, pins `@earendil-works/pi-coding-agent`.
  Defines `npm run pi` (raw pi from `pi-sandbox/`) and `npm run mesh`
  (host-recipe-driven multi-agent launcher — `npm run mesh -- <recipe-name>`).
- `models.env` — tier → model-ID mapping. See [model-tiers.md](./model-tiers.md).
- `AGENTS.md` / `CLAUDE.md` — thin index files at repo root. **Not** loaded
  into pi sessions (`npm run pi` passes `-nc`).
- `docs/` — this folder. Long-form docs split out of `AGENTS.md`.

## packages/ — pi package workspace

The AgentFactory extension packages live here. Each is a pi package
(declared with `"keywords": ["pi-package"]`) loadable via `pi install`.

- `packages/engine/` — `@agentfactory/pi-engine`. Always-on package:
  the `recipe-loader` extension (registers `--recipe` and six launch flags:
  `--sandbox`, `--task`, `--peer-name`, `--topology-overlay`, `--inherit-pty`,
  `--debug`), the recipe resolver (`agent/lib/resolve-recipe.ts`), model-tier
  resolver (`agent/lib/resolve-model.ts`, `agent/lib/load-tier-config.ts`),
  and the full mesh subsystem (`agent-bus`, `supervisor`, `intercept`,
  `launcher-bridge`, `slash-commands`, `bus-tail-emitter`, `mesh-rail`,
  `mesh-authority`). Extensions live in `agent/extensions/`; library
  modules in `agent/lib/`. Bundled recipes dir (`agent/recipes/`) is
  currently empty — this repo's recipes live in `pi-sandbox/agents/`.
- `packages/deferred-rails/` — `@agentfactory/deferred-rails`. Rails for
  buffered, approval-gated file operations: `deferred-confirm`,
  `deferred-write`, `deferred-edit`, `deferred-move`, `deferred-delete`.
- `packages/containment-rails/` — `@agentfactory/containment-rails`. Rails
  for FS containment: `sandbox`, `no-edit`.
- `packages/ui-rails/` — `@agentfactory/ui-rails`. Rails for the TUI
  chrome: `agent-header`, `agent-footer`, `no-startup-help`,
  `hide-extensions-list`.

Each cluster depends only on `@agentfactory/pi-engine` — a star topology
with no inter-cluster edges.

## pi-sandbox/ — pi's content

Pi's working directory is `pi-sandbox/`; the `npm run pi` script handles the
`cd` for you.

- `pi-sandbox/agents/` — YAML recipes for `pi --recipe <name>`. Recipe
  search order: project-local `.pi/recipes/` → `~/.pi/agent/recipes/` →
  bundled in the engine package (currently empty). Recipes in this dir
  are found when `pi --recipe` is invoked from the repo root. Also hosts
  host recipes (e.g. `anon-grouped-mesh.yaml`, `authority-mesh.yaml`,
  `grouped-mesh.yaml`) launched via `npm run mesh -- <recipe-name>`.
- `pi-sandbox/templates/` — Template YAML files used by `extends:` chains
  in recipes (e.g. `peer.yaml`).
- `pi-sandbox/.pi/extensions/` — Project-local pi extensions. Used during
  development; production extensions live in `packages/*/agent/extensions/`.
- `pi-sandbox/.pi/scratch/` — Throwaway prompt files, raw pi output,
  anything you don't want to check in. Gitignored.
- `pi-sandbox/skills/pi-agent-builder/` — pi skill that teaches pi how
  to build agents.

## Workflow

- **Launch a focused agent** with `pi --recipe <name>` from the repo root.
  Pass `--sandbox <dir>` to pin the working directory.
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
