# Host recipes — `--is-host`, `initial_mesh:`, pre-spawned peers

Parent: [`../agents.md`](../agents.md). See also:
[`multi-agent.md`](./multi-agent.md) · [`testing.md`](./testing.md).

## Host vs worker — what's the difference?

A **host recipe** is one that orchestrates a mesh: it owns the launcher
socket, binds the PTY pool, and pre-spawns the peers declared in
`initial_mesh:` at `session_start`. The canonical identity test is:
if the launch line is `pi --recipe X --is-host` (or `npm run mesh -- X`,
which sets `--is-host` automatically), the recipe is a host recipe.

A **worker recipe** is any recipe launched without `--is-host`. Workers
receive a `--topology-overlay` JSON blob from the launcher (built by
`mesh-mux` or `mesh-spawn`) and operate within the peer relationships that
blob encodes. Worker sessions ignore `initial_mesh:` entirely — `mesh-mux`
self-gates on `getHabitat().isHost` and is a silent no-op for workers.

The same YAML file can serve as both a host recipe and a standalone agent:
`--is-host` is the switch. Without it, a recipe with `initial_mesh:` entries
simply never processes them; with it, the full mesh machinery activates.

## When to write each kind

| You want | Kind | Key recipe fields |
| --- | --- | --- |
| A focused agent that writes/reads files | Worker | `tools`, `extensions`, `prompt` |
| An agent that dynamically spawns helpers | Worker-with-spawn | `spawns:`, + `mesh_spawn`/`mesh_kill` auto-added |
| A pre-wired team that boots as a unit | Host | `spawns:`, `initial_mesh:` |
| An authority that accepts submissions from workers | Host or named authority worker | `acceptsWorkFrom:`, `tools: [respond_to_request]` |

## Host-recipe shape

A host recipe is a standard recipe with `spawns:` and `initial_mesh:`
populated. Below is a simplified version of `authority-mesh.yaml`:

```yaml
# pi-sandbox/agents/authority-mesh.yaml
extends: peer
model: LEAD_HARE_MODEL
shortName: authority-mesh
description: "Authority mesh host — pre-spawns anonymous analyst and writer peers."

prompt: |
  You are the authority in this mesh. Two worker peers (an analyst and a writer)
  are pre-spawned for you. Use peer_send / peer_call to coordinate.

tools:
  - read
  - ls
  - peer_list
  - peer_send
  - peer_inbox
  - peer_call

spawns:
  - mesh-node
  - mesh-writer

initial_mesh:
  - recipe: mesh-node
    task: |
      You are the research analyst. Wait for requests from the host.
  - recipe: mesh-writer
    task: |
      You are the drafting writer. When given a drafting request, save
      the content to a file and reply with the file path.
```

And a named-peer variant from `mesh-host-example.yaml`:

```yaml
spawns:
  - mesh-node
  - mesh-writer

initial_mesh:
  - recipe: mesh-node
    name: analyst          # stable bus name — used in peer_call({to: "analyst", ...})
    groups: [research]
    task: "You are the research analyst. Wait for research requests from the host."
  - recipe: mesh-writer
    name: scribe
    groups: [drafting]
    task: "You are the scribe. Wait for drafting requests from the host."
```

### `initial_mesh:` entry fields

| Field | Type | Description |
| --- | --- | --- |
| `recipe` | string (required) | Recipe name — must be in `spawns:` |
| `name` | string (optional) | Stable bus name; auto-generated if omitted |
| `groups` | string[] (optional) | Group memberships; ungrouped peers join `@_default` |
| `task` | string (optional) | Per-instance role text appended to the system prompt |
| `escalatesTo` | string (optional) | Override the peer this worker escalates approvals to |
| `submitsWorkTo` | string (optional) | Override the peer this worker submits work to |
| `acceptsWorkFrom` | string[] (optional) | Override which peers can send typed envelopes |
| `messagesWith` | string[] (optional) | Override which peers this worker may address |

`@ref` expressions (`@<group>`, `@$spawner`, etc.) are resolved against
the pre-allocated peer-group index before any peer is running.

### `spawns:` on a host vs a worker

On a **host** recipe, `spawns:` defines the allowlist for both
`initial_mesh:` entries and runtime `mesh_spawn` calls.

On a **worker** recipe, `spawns:` is the same allowlist for runtime
`mesh_spawn` calls only — the worker does not process `initial_mesh:`.

Either way, a non-empty `spawns:` causes the engine to auto-load the
`mesh-spawn` extension and add `mesh_spawn`/`mesh_kill` to active tools.

## Launching a host recipe

```sh
set -a; source models.env; set +a

# Preferred — sets --is-host automatically:
npm run mesh -- authority-mesh

# Equivalent long form:
pi --recipe authority-mesh --is-host
```

What `--is-host` activates (see `recipe-loader.ts:259-260` and `mesh-mux.ts`):

- Sets `Habitat.isHost = true` in the engine recipe-loader (`recipe-loader.ts:259-260`).
- `mesh-mux.ts` self-gates on `getHabitat().isHost`; when true it:
  - Binds `${busRoot}/__launcher__.sock` via `LauncherSocket`.
  - Creates `PtyPool` / `Multiplexer` / `FocusController` / `DecisionsQueue` /
    `BusTailBuffer`.
  - Processes the recipe's `initial_mesh:` block, pre-spawning each entry.
  - Handles `spawn-request` / `kill-request` envelopes from worker peers.
  - Cascade-kills all spawned peers on `session_shutdown`.
- `--is-host` is **not** forwarded to children via `buildRecipeChildArgv`
  (see `recipe-loader.ts:308-309`) — workers always get `isHost = false`.

## Implicit-wire rules summary

See the [Implicit-wire rules](../agents.md#implicit-wire-rules) section in
`agents.md` for the full rule set. In brief:

- Non-empty `spawns:` ⇒ `mesh-spawn` extension auto-loaded, `mesh_spawn`/`mesh_kill` auto-added.
- `tools: [mesh_spawn]` without `spawns:` ⇒ recipe rejected at parse time.
- Non-empty `initial_mesh:` ⇒ recipe must be launched with `--is-host`; otherwise `initial_mesh:` is ignored.

## Migrating from the old topology-file pattern

The old topology-YAML pattern (`pi-sandbox/meshes/<name>.yaml` + `npm run mesh -- <file>`)
is superseded by host recipes. The migration mapping is straightforward:

- **Topology `nodes:` list** → `initial_mesh:` entries on the host recipe.
- **Per-node `supervisor:` / `submitTo:`** → `escalatesTo:` / `submitsWorkTo:` per entry (overlay-input keys).
- **Per-node `acceptedFrom:` / `peers:`** → `acceptsWorkFrom:` / `messagesWith:` per entry.
- **Topology `group_bindings:`** → per-entry explicit `messagesWith:` / `acceptsWorkFrom:` fields
  (host recipes use per-entry fields, not group-level bindings).
- **Topology `entry:` / top-supervisor** → the host recipe itself is the authority.

See `pi-sandbox/agents/grouped-mesh.yaml` header comment for a worked
example of an old topology's group bindings expanded into per-entry fields.

## See also

Existing host recipes in `pi-sandbox/agents/`:

- [`authority-mesh.yaml`](../../pi-sandbox/agents/authority-mesh.yaml) — anonymous analyst + writer, no group namespacing.
- [`grouped-mesh.yaml`](../../pi-sandbox/agents/grouped-mesh.yaml) — named analyst, writer, reviewer in `workers`/`reviewers` groups.
- [`anon-grouped-mesh.yaml`](../../pi-sandbox/agents/anon-grouped-mesh.yaml) — single anonymous worker in the `workers` group.
- [`mesh-host-example.yaml`](../../pi-sandbox/agents/mesh-host-example.yaml) — named `analyst` + `scribe` in `research`/`drafting` groups; canonical launch example.
