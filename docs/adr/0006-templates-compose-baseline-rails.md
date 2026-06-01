# Templates compose baseline rails; recipes append per-role rails

The set of **Rails** every **Recipe** loads is no longer hardcoded in `scripts/run-agent.mjs`. It moves into a YAML primitive, the **Template**, that lives in `pi-sandbox/templates/`. The shipped default `peer.yaml` carries every rail a peer needs (containment, supervisor inbound, bus, launcher integration). Recipes opt into this baseline with `extends: peer` and append per-role rails (e.g. `mesh-authority`, `deferred-write`, `no-edit`) via their own `extensions:` field. `extends:` is optional — recipes may run bare. Per-recipe overrides `noEditAdd`/`noEditSkip` are deleted (no recipe ever set them); the no-edit rail relies on its static fallback plus tool introspection. All non-tier environment variables (`PI_MESH_PEER`, `PI_AGENT_BUS_ROOT`, `PI_AGENT_NAME`, `AGENT_DEBUG`) become CLI flags on the runner; only `RABBIT_SAGE_MODEL`, `LEAD_HARE_MODEL`, `TASK_RABBIT_MODEL` remain as env vars because the user sets them in `models.env`.

## Why

- **The baseline is supposed to be discoverable.** Today a contributor reading a recipe cannot tell what extensions actually load — the answer lives in `BASELINE_EXTENSIONS` (run-agent.mjs:19-40) and `MESH_PEER_EXTENSIONS` (run-agent.mjs:49-54), neither of which is referenced from any YAML. `extends: peer` makes the baseline a path the reader can follow.
- **Mesh-peer rails belong with peer rails.** The `MESH_PEER_EXTENSIONS` set (`launcher-bridge`, `slash-commands`, `bus-tail-emitter`, `mesh-rail`) was env-var-gated on `PI_MESH_PEER=1` because the runner had no other way to express "load these only when running under the launcher". Each of those extensions already self-gates on launcher-socket presence — the gating was redundant. Putting them in `peer.yaml` for everyone replaces "guess from an env var" with "always loaded; silent when no launcher socket is bound" and matches the user's stated principle that every recipe should be able to be a peer.
- **Per-role rails are not bundles.** The deferred-* family (`deferred-write`, `deferred-edit`, `deferred-move`, `deferred-delete`) and `no-edit` compose freely per recipe. A single-inheritance template chain handles "what's universal"; the recipe's own `extensions:` field handles "what this role adds". Two simple mechanisms beat one complex one.
- **Existing recipes drift on tools.** `mesh-node`, `mesh-writer`, `peer-chatter` all redeclare the same `agent_send` / `agent_inbox` / `agent_list` / `agent_call` tool block when listing `agent-bus`. The duplication caused divergence (`mesh-node` adds `agent_call`; `peer-chatter` does not). Moving `agent-bus` into `peer.yaml` while keeping tool allowlists per-recipe lets each recipe keep its capability surface explicit without copy-pasting the rail every time.
- **Env vars leak through process trees.** `PI_MESH_PEER=1`, `PI_AGENT_BUS_ROOT=...`, etc. propagate to every sub-process spawned via `delegate` or `mesh_spawn`. CLI flags do not. Since the system already has CLI-flag equivalents for `PI_AGENT_BUS_ROOT` (`--agent-bus`) and `PI_AGENT_NAME` (`--agent-name`), the env var fallbacks are pure carryover; deleting them removes a class of "child saw the wrong root" bugs.
- **`noEditAdd`/`noEditSkip` are dead plumbing.** No recipe in the repository sets them. They were retained "for future flexibility" but the no-edit rail's discovery logic (introspect `pi.getAllTools()` for create-only tool shape) covers every case the overrides would address. ADR-0001 already foreshadowed their removal; we are catching up.

## Considered alternatives

- **Recipes-extend-recipes, no separate template type.** Any recipe could be extended by any other via `extends:`. Rejected: templates and recipes have different jobs (a template defines a containment shape; a recipe defines a role). Conflating them via shared `extends:` semantics makes "is this thing a leaf?" a runtime guess and forces every reader to determine intent from context.
- **Multiple inheritance / mixins (`extends: [base, deferred-write-rail, no-edit-rail]`).** Each rail becomes a tiny template; recipes compose freely. Rejected: merge order across multiple parents requires its own rules ("template-list order vs recipe-extensions order"), and the only concrete use case (the deferred-* family) is already handled by single-inheritance + recipe.extensions with one merge rule (template first, recipe second, dedupe).
- **Recipe declares no rails; per-recipe template per role.** `pi-sandbox/templates/deferred-writer.yaml`, `deferred-author.yaml`, etc., one per recipe. Rejected: explosion of templates in 1:1 correspondence with recipes — moves the duplication one directory up rather than removing it.
- **Authority capability as a separate template (`authority.yaml extends peer`).** Recipes that spawn other peers would `extends: authority`. Rejected per user: the user's principle is "every recipe should be able to have peer function; some recipes can give the capability to extend the mesh" — i.e. peer is universal in the template, authority is universal in the runtime (every loaded extension is available) but recipe-gated through the `tools:` allowlist. Symmetric with `agent-bus` (loaded for everyone, peer-talk tools per-recipe).
- **`extends:` required on every recipe (F3).** Self-documenting baseline, but real recipes sometimes want to opt out of the universal bundle entirely (testing, minimal demos, future seed-agent shapes). Required `extends:` would force every such recipe into a hand-rolled `bare.yaml` template just to say "no rails". Optional `extends:` covers both cases with one rule: omitted = bare; named = must resolve.
- **Implicit default to `peer` when `extends:` is omitted (F2).** Convenient — every existing recipe keeps working. Rejected per user: the baseline being explicitly named in each recipe is more honest than a hidden default. Bare recipes opt out by omitting `extends:`; non-bare recipes write `extends: peer`.
- **Topology gets templates too (G2/G3).** Topology files inherit nodes, groups, group bindings from a parent topology, or per-node `extends:` overrides the recipe's template choice for that one slot. Rejected: shipped topologies are already short (24-85 lines); the composition primitive that matters at topology level (`@group`, `group_bindings`) already exists. Adding inheritance to a small file format is a tax every reader pays.
- **Move launcher singleton state (focus, decisions, bus-tail buffer) into a peer extension.** Would require electing one peer to be the "human-relay" — the anti-pattern ADR-0004 retired. Rejected: the launcher is the human's process; human-facing state lives where the human does. The launcher's remaining responsibilities (PTY pool, multiplexer, stdin routing, launcher-socket bind, per-node spawn, crash auto-shift) are bound to OS-level affordances that pi extensions cannot host.
- **Reframe the launcher itself as a process loading "launcher-side extensions" (K2).** Genuinely beautiful but a new framework with no second consumer. Deferred: revisit once the template system has shaken out and a real second launcher (web, CI batch) materialises.

## Consequences

### New artifact

- `pi-sandbox/templates/peer.yaml` ships with the full universal-rail list:
  ```yaml
  extensions:
    - habitat
    - sandbox
    - no-startup-help
    - agent-header
    - agent-footer
    - hide-extensions-list
    - deferred-confirm
    - supervisor
    - intercept
    - agent-bus
    - launcher-bridge
    - slash-commands
    - bus-tail-emitter
    - mesh-rail
  ```

### Recipe schema

- New optional field `extends: <template-name>` (string). Resolves to `pi-sandbox/templates/<name>.yaml`; missing file is a `die()` error.
- Existing field `extensions: [...]` stays; semantics change from "sole source of rails" to "additions on top of the template". Each entry must resolve to a file in `pi-sandbox/.pi/extensions/`.
- Deleted: `noEditAdd`, `noEditSkip`. Recipes setting them after this lands are rejected at parse time (the validator already loud-fails on unknown fields once the schema is updated).
- Effective extension list at runtime = `template.extensions ++ recipe.extensions ++ implicit-wires` (atomic-delegate when `agents:` is non-empty), deduped first-occurrence.

### Validation

- `extends:` to non-existent template → `die()`.
- `extensions:` listing non-existent extension → `die()` (existing behaviour).
- Template listing non-existent extension → `die()`.
- Recipe extension already in template → silent dedup, no warning.
- `extensions: [atomic-delegate]` without `agents:` → `die()` (existing inverse-rejection rule).
- Bare recipe (no `extends:`) → allowed; the runner does not second-guess. A bare recipe that lists rails depending on `habitat` will crash at `getHabitat()` — the user's call.

### Runner (`scripts/run-agent.mjs`)

- `BASELINE_EXTENSIONS` and `MESH_PEER_EXTENSIONS` constants deleted.
- `isMeshPeer` derived state (line 276) deleted; replaced where needed by parsed CLI flags.
- New CLI flags parsed by the runner:
  - `--inherit-pty` (boolean) — set by the launcher when the runner's stdout is already inside the launcher's managed PTY. Replaces the rail-gating use of `PI_MESH_PEER=1`; the PTY-in-PTY detection at `run-agent.mjs:444-449` reads this flag instead of the env var.
  - `--debug` (boolean) — replaces `AGENT_DEBUG=1`. Stored as `Habitat.debug`; extensions read `getHabitat().debug` instead of `process.env.AGENT_DEBUG`.
  - `--topology-path <file>` and `--node-name <name>` — passed by the launcher; the runner reads the topology YAML and computes its own overlay for the named node (replaces `--topology-overlay <json>`).
- `applyAgentsField` continues to implicit-wire `atomic-delegate` and `delegate` when `agents:` is non-empty; unchanged.
- `mergeBaselineTools` keeps force-including `respond_to_request` because supervisor remains a baseline rail (now via `peer.yaml` rather than the JS constant).

### Habitat (`pi-sandbox/.pi/extensions/_lib/habitat.ts`)

- Drop `noEditAdd: string[]` and `noEditSkip: string[]` from the type and JSON schema.
- Add `debug: boolean` (default `false`).
- Drop env-var fallbacks for `PI_AGENT_NAME` (line 48) and `PI_AGENT_BUS_ROOT` (line 51); the runner always provides them via `--habitat-spec`.

### Extensions

- `no-edit.ts`: drop the overlay logic that read `h.noEditAdd` / `h.noEditSkip` (lines 53-63). The static fallback (`{write, deferred_write}`) plus runtime introspection of `pi.getAllTools()` for create-only tool shape covers every case.
- `agent-bus.ts`, `habitat.ts`, `mesh-authority.ts`: remove env-var fallbacks for `PI_AGENT_NAME` and `PI_AGENT_BUS_ROOT`; values arrive exclusively via the runner's CLI flags / `--habitat-spec`.
- `launcher-bridge.ts`: remove the `process.env.PI_MESH_PEER === "1"` debug branch (line 175).
- All extensions reading `process.env.AGENT_DEBUG === "1"` (~12 sites) switch to `getHabitat().debug === true`.

### Launcher (`scripts/launch-mesh.mjs`)

- Stops doing per-node overlay resolution. The launcher passes `--topology-path <file>` and `--node-name <name>` to each runner; each runner parses the topology and computes its own slot. Round-robin determinism for `@group` scalar refs is preserved because every runner traverses the same node-declaration order with the same counter — input identical, output identical.
- Stops setting `PI_MESH_PEER=1` and `PI_AGENT_BUS_ROOT` / `PI_AGENT_NAME` env vars on per-node spawn; passes the equivalents as CLI flags (`--inherit-pty`, `--agent-bus`, `--agent-name`).
- Wiring helpers extract into `scripts/_lib/launcher.mjs`. The `launch-mesh.mjs` entry script ends up roughly as a wiring sketch (parse topology → create pool + mux + socket → spawn N runners → wire teardown). Singleton state (focus controller, decisions queue, bus-tail buffer) stays in the launcher process; relocating it would require electing a "human-relay" peer (rejected above).
- K2 (the launcher itself becoming a host for "launcher-side extensions") is explicitly deferred. The K1 changes above leave K2 viable as a future refactor.

### Topology (`pi-sandbox/meshes/<name>.yaml`)

- Schema unchanged. Topology composability via templates was rejected (G1).
- Validator unchanged in shape; runs in the runner now (since the runner self-resolves) rather than only in the launcher. The runner re-uses `_lib/topology-validator.mjs` and `_lib/topology.mjs`.

### Migration

- 11 recipes need editing: each gets `extends: peer` added (where appropriate), `agent-bus` removed from `extensions:` (now in `peer.yaml`), and any `noEditAdd`/`noEditSkip` deleted.
- Tests: drop `noEdit*` overlay tests in `_lib/habitat.test.ts`; update `_lib/escalation.test.ts` and `_lib/supervisor-inbox.test.ts` to remove `noEditAdd: []` / `noEditSkip: []` from fixture habitats.
- `docs/agents.md`: rewrite the "Recipe shape" and "Composing agents" sections to describe `extends:` and the template chain. Drop the `noEditAdd`/`noEditSkip` paragraph.
- `CONTEXT.md`: already updated to introduce **Template** as a first-class term and refine **Recipe** to mention `extends:`.
- The migration is grabbable as a sequence of vertical slices (one per concern: template file, runner, habitat, extensions, launcher, recipes, tests, docs); each slice is independently testable.

## Addendum (2026-06, #194)

The canonical home of `peer.yaml` is now `packages/engine/agent/templates/`
(shipped via the engine package's `files: ["agent/"]` — see
`packages/engine/package.json`). The repo-local copy at
`pi-sandbox/templates/peer.yaml` has been removed; `getTemplateDirs` falls
through to the bundled engine copy as the final tier in the search order.
`pi-sandbox/templates/` is retained as an optional repo-local override
directory — place a `peer.yaml` there to shadow the bundled copy for
repo-local experimentation. This makes the engine package the single source
of truth for the baseline peer template and ensures `peer.yaml` is always
present in any downstream install of `@agentfactory/pi-engine`.
