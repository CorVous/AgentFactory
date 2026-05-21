# `pi --recipe` replaces the wrapper launcher; AgentFactory ships as global pi packages

`scripts/run-agent.mjs` and `npm run agent` are deleted. Launching a focused agent becomes `pi --recipe <name>` — `--recipe` is a flag registered by an **engine** pi extension that, at `session_start`, resolves the recipe and drives `pi.setModel` / `pi.setActiveTools` / a `before_agent_start` system prompt. AgentFactory is distributed as pi packages installed globally into `~/.pi`; the engine auto-loads on every `pi` invocation but is **loaded-but-inert** — with no `--recipe`, raw `pi` behaves like vanilla pi. The rails are packaged as one always-on `engine` package plus three independently-installable, generic clusters; the mesh subsystem folds into the engine rather than being a fourth cluster.

## Why

- **The launcher cannot be installed.** `run-agent.mjs` only works from a clone of this repo — it resolves `pi-sandbox/agents/`, `models.env`, and `node_modules/.bin/pi` by relative path. The user's goal is to run focused agents in *any* project. A wrapper script cannot be `pi install`-ed; a pi extension can. Making `--recipe` a flag on an extension is the only shape that ships globally.
- **pi already exposes the reconfiguration surface.** pi has no native recipe concept and no runtime extension-loading, but `pi.setModel`, `pi.setActiveTools`, and a `before_agent_start` system-prompt override are enough to reconfigure a session at `session_start`. This is verified against pi's own `examples/extensions/preset.ts`, which does exactly this. No wrapper process is needed to "prepare" pi.
- **A global install must be invisible until asked for.** Installing into `~/.pi` means the engine loads on *every* `pi` invocation machine-wide. "Loaded-but-inert" — no `--recipe` ⇒ no recipe resolved ⇒ no Habitat materialised ⇒ every config rail self-gates to a no-op — keeps that install from changing the behaviour of plain `pi`.
- **The engine/config-rail split is a reusability split, not a load-cost split.** `sandbox`, `no-edit`, and the UI rails are *generic* — useful in plain `pi` with no recipe — so they earn their place as separate, independently-installable extensions. The mesh subsystem (bus, supervisor, intercept, launcher integration) is *not* reusable: nobody installs `agent-bus` standalone. It is AgentFactory-specific machinery, exactly like the recipe-loader, so it belongs *in the engine*.
- **Folding mesh into the engine dissolves two false problems.** As a separate optional cluster, mesh forced (a) a `peer.yaml` template split so solo recipes would not hard-error on an uninstalled cluster, and (b) a question of whether `Habitat`'s mesh fields (`busRoot`, `supervisor`, `acceptedFrom`, …) should leave the engine's core type. With mesh *in* the engine, the engine legitimately owns those fields and `extends: peer` always resolves. The cost — the mesh-extensions refactor (ADR-0007/0008/0009) will churn the engine package — is acceptable: that refactor is a coordinated rewrite regardless, and is itself the right moment to extract mesh cleanly if ever wanted.

## Considered alternatives

- **Keep a thin wrapper script, just make it installable.** Rejected: a wrapper still has to be on `PATH`, still shadows or wraps the real `pi`, and still cannot be composed with other pi extensions a user has installed. The extension form is the only one that disappears when unused.
- **Mesh as a fourth, separate cluster (`mesh-rails`).** The original plan. Rejected mid-design: mesh is not a reusable building block, and separating it spawned a template split and a `Habitat` struct-split with no payoff — pure separation tax on a subsystem about to be rewritten anyway.
- **Lazy-import the mesh modules so solo agents never pay the jiti cost.** Rejected: mesh tools (`agent_send`, `respond_to_request`, …) must be in `pi.getAllTools()` at load time for recipe `tools:` allowlists to resolve. Deferring the import fights pi's load model for ~7 small modules' worth of cost. "Lightweight" is achieved instead by self-gating plus lazy *resource* acquisition (no socket bind / no launcher connect until the Habitat actually has peers).
- **Drop the tier abstraction; recipes name literal model IDs.** Rejected: loses `docs/model-tiers.md` as a concept and forces editing every recipe to re-point models. Tiers resolve env var → user override file → bundled default map instead, so `pi --recipe` works on a fresh machine and stays overridable.
- **Auto-install a missing config-rail cluster.** Rejected: a recipe silently triggering network fetches and arbitrary-code installs is a security footgun. A referenced-but-uninstalled cluster is a hard error with a `pi install` hint. Silently skipping is worse still — skipping `sandbox` disables FS containment without telling anyone.
- **Do this as part of the mesh-extensions refactor (ADR-0007/0008/0009).** Rejected: that refactor is a ~50-file epic and is 0% started. `pi --recipe` is orthogonal (a launcher change vs. a mesh-growth-model change) and independently shippable. Doing it first also *shrinks* the refactor — its launcher slices rebase onto `pi --recipe` instead of inventing a thin-launcher story.

## Consequences

### Packaging

- **`engine`** (one always-on package): the recipe-loader, `habitat`, and the mesh subsystem (`agent-bus`, `supervisor`, `intercept`, `launcher-bridge`, `slash-commands`, `bus-tail-emitter`, `mesh-rail`, `mesh-authority`). Mesh stays lightweight via self-gating and lazy resource acquisition.
- **`deferred-rails`**, **`containment-rails`**, **`ui-rails`**: three independently-installable clusters of generic rails (`deferred-confirm` + `deferred-write/edit/move/delete`; `sandbox` + `no-edit`; `agent-header` + `agent-footer` + `no-startup-help` + `hide-extensions-list`). Each depends only on `engine` — a star, no inter-cluster edges.
- Recipes still compose *individual* rails in `extensions:`; per-cluster packaging is a distribution detail. The resolver maps rail → package and hard-errors with an install hint if the owning cluster is absent.

### Launcher and recipe resolution

- `scripts/run-agent.mjs` and the `npm run agent` script are deleted. `pi --recipe` is the sole single-agent launcher.
- `pi --recipe <name>` resolves a bare name across `<cwd>/.pi/recipes/` → `~/.pi/agent/recipes/` → bundled-in-package (project > global > bundled); an explicit path is also accepted. `.yaml` is canonical.
- `scripts/launch-mesh.mjs` and `atomic-delegate` repoint to spawn `pi --recipe <recipe>` children. The engine registers the launch flags they pass (`--sandbox`, `--task`, `--peer-name`, `--topology-overlay`, `--inherit-pty`, `--debug`).

### Habitat

- `habitat` merges into the engine: the recipe-loader builds the `Habitat` object directly and calls `setHabitat()`. The `--habitat-spec` JSON flag and the `materialiseHabitat` round-trip are dropped — they only existed to pass data between the now-deleted launcher process and pi. `_lib/habitat.ts` (the type + `getHabitat`/`setHabitat`) survives as the shared contract. ADR-0002 (materialise once) still holds.
- The `Habitat` struct stays monolithic — the engine owns the mesh subsystem, so it owns the mesh fields. No struct split.
- The "anonymous fallback" Habitat for raw `pi` goes away; no `--recipe` ⇒ no Habitat, and no config rail is active to read one.

### Carried forward / out of scope

- `extends:` Templates (ADR-0006) carry forward unchanged; `peer.yaml` stays.
- The mesh-extensions refactor (ADR-0007/0008/0009) remains a separate future epic; `atomic-delegate` is deleted there, not here. Its launcher slices rebase onto `pi --recipe --is-host`.
- Extracting a swappable `BusTransport` interface is tracked separately as issue #146.
- `docs/agents.md`, `docs/repo-layout.md`, `docs/pi-direct.md`, and `CONTEXT.md`'s **Host** entry reference `npm run agent` / `run-agent.mjs` / `pi-sandbox/` paths and need rewriting during implementation. `docs/migration-mesh-refactor.md`'s launcher slices are superseded by this ADR.
