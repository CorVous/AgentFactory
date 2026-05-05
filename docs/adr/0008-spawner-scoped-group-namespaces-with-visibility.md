# Group namespaces are spawner-scoped; visibility is the routing primitive

A **Group** is a labeled subset of peers within a single spawner's namespace. Membership is declared per-instance at spawn time (`groups:` field on `initial_mesh:` entries and as a parameter to `mesh_spawn()`); one peer may belong to multiple groups; one peer may belong to none, in which case it joins the implicit `@_default` group. Group references in **Recipe** wiring fields use namespace syntax: `@<group>:<recipe>` for recipe-typed lookup, `@<group>` for any recipe. Resolution is *spawner-scoped*: the same group name under different spawners refers to disjoint sets, and a peer's group references resolve only within its own spawner's namespace. **Visibility scoping** — a peer can address only peers it shares at least one group with within its spawner's namespace, plus the structural spawner↔child edge — replaces the topology-time `acceptedFrom` allowlist as the primary routing gate. ADR-0005's launch-time `@<name>` resolution is superseded for the host-grown mesh; topology-only group syntax disappears with the topology artifact (per ADR-0007).

## Why

- **Address leak prevention requires scope, not just allowlists.** Today's `acceptedFrom:` rejects cross-cohort envelopes at the rail level; a sender can still *try*, the receiver still pays the cost of dispatch and rejection, and `peer_list` returns peers the sender can't reach. Visibility scoping pushes the gate up to enumeration: a peer literally doesn't know about peers it can't address. The mesh-update broadcast list is filtered before it leaves the host; `peer_list` returns only visible peers; `acceptsWorkFrom:` becomes an inner check after visibility.
- **Group names should be local, not global.** Mesh-wide group identifiers leak across the **Spawn Tree**: if the host spawns a `[haiku]` cohort *and* a critic later spawns its own `[haiku]` sub-cohort, mesh-global naming would either collide them or force topology-wide unique-name discipline. Spawner-scoped namespacing makes group names a recipe-author convenience, not a coordination problem. Two spawners using the name "haiku" produce two unrelated groups; no need for cross-tree negotiation.
- **Generic recipes parameterised by group context.** A `writer` recipe doesn't know whether it'll spawn into a haiku or story team; the spawner does. With spawner-scoped groups and `$myGroups` symbolic resolution, the writer recipe writes `submitsWorkTo: "@$myGroups:reviewer"` once and gets the right reviewer cohort regardless of which group context it spawns into. This collapses today's `mesh-writer` / `mesh-node` recipe duplication: roles are generic; specialisation comes from the group annotation at spawn time.
- **Singular-field group resolution stays singular.** Today's ADR-0005 round-robin for scalar `@group` references already produces a per-worker concrete name at launch; this ADR keeps that semantic and ports it to spawner-scoped groups. `submitsWorkTo: "@$myGroups:reviewer"` resolves to one concrete reviewer at the spawning peer's instantiation moment, sticky for that peer's lifetime. The Habitat continues to carry singular fields as concrete strings; no rail learns about groups.
- **List-field group resolution stays expanded, with sender-side fan-out.** `peer_send({to: "@$myGroups", body: ...})` expands locally in the sender's `peer-bus` extension against its visible-peers cache and emits N point-to-point envelopes. The bus stays decentralised; the host doesn't relay messages. Group sugar is a sender-side convenience; the wire format is unchanged.

## Considered alternatives

- **Mesh-global groups (ADR-0005's launch-time resolution extended to the whole mesh).** Rejected per user: name collisions across subtrees become a real authoring concern; the system has to decide whether two spawners' "haiku" groups merge (loss of isolation) or are forbidden (loss of authoring autonomy). Spawner-scoped namespacing avoids the choice entirely.
- **Allowlist-only visibility (no enumeration scoping).** Keep group references as allowlist tokens; let `peer_list` return everyone in the cohort; let `acceptsWorkFrom:` reject at the rail. Rejected: the `peer_list` leak alone is enough to violate the user's stated "no address leak" requirement. Once visibility scoping handles enumeration, the allowlist becomes a redundant inner check; it survives only as a defence-in-depth measure for typed control envelopes.
- **Dynamic groups by content (LLM-tagged peers via "tag" tool calls).** Each peer can dynamically join/leave groups via tool calls. Rejected for v1: introduces runtime authorization questions ("can any peer join any group? on whose authority?") and complicates the spawner-scoped namespace ("can a peer join a group that no spawner declared?"). Spawn-time-only membership keeps the model deterministic and verifiable.
- **Cross-tier group references (`@$myChildren:writer`, `@$mySpawner:reviewer`).** Rejected for v1: opens the door to deep tree-walking semantics and reintroduces cross-namespace lookup that the spawner-scope rule was meant to prevent. Recipes that need deep coordination spawn directly rather than nesting through intermediaries. A future ADR may revisit if a real use case emerges.
- **Groups as a separate top-level YAML key (`groups: { haiku: [w1, w2] }`).** Rejected per user: group declaration belongs *next to* the spawn it affects (i.e., on the `initial_mesh:` entry or `mesh_spawn()` call), not in a parallel block that authors have to keep in sync. Inline declaration also makes the runtime mesh_spawn case symmetric with boot-time `initial_mesh:` — both attach `groups:` to the spawn act.
- **Separate envelope kinds for group-multicast (`multicast-message` envelope; host as fan-out relay).** Rejected: introduces the host as a relay in the bus path, which contradicts the "decentralised peer-to-peer bus" property carried over from ADR-0001. Sender-side fan-out keeps the bus shape intact; the cohort-tracker cache makes local expansion cheap.
- **Visibility scoping at the bus layer (`peer-bus` rejects unknown sender).** Considered as the primary gate. Rejected as the *only* gate: without enumeration scoping (`peer_list` filtering, `mesh-update` filtering), the sender's cohort cache could still leak names. Visibility has to apply at every information surface, not just the wire.
- **`@_default` requires explicit declaration.** Force every flat-mesh recipe to write `groups: [_default]` rather than letting ungrouped peers join automatically. Rejected: no payoff for the boilerplate. Defaulting ungrouped peers to `@_default` lets simple meshes ignore groups entirely; flat-mesh ergonomics stay clean.

## Consequences

### Domain

- **CONTEXT.md gains the term "Group"** (definition above). The term **Sibling Cohort** is reaffirmed for "peers spawned by the same spawner" (the *unfiltered* same-spawner set); **Group** is a *labeled subset* of a sibling cohort.
- **`$myGroups` is a new symbolic reference** alongside `$spawner` and `$siblings`. Resolves to "the set of groups the resolving peer was tagged with at spawn time."

### Reference grammar

- `@<group>:<recipe>` — instances of `<recipe>` in `<group>` (e.g. `@haiku:writer`).
- `@<group>` — all peers in `<group>` regardless of recipe.
- `@<recipe>` — short for `@$myGroups:<recipe>`; instances of `<recipe>` in any group the resolving peer is a member of.
- `@$myGroups` — all peers in any group the resolving peer is a member of.
- `@$myGroups:<recipe>` — recipe-typed variant of `@$myGroups`.
- `$siblings` — same-spawner cohort, intersected with the resolving peer's visible peers (i.e. peers sharing at least one group within the spawner's namespace).
- `$spawner` — unchanged; resolves to the peer's spawner. The spawner ↔ child edge is structurally visible regardless of group membership.

### Resolution policy

- **Singular fields (`escalatesTo:`, `submitsWorkTo:`)** — group references resolve at spawn time via per-instance sticky round-robin. Counter is keyed by `(spawnerName, groupRef, fieldName)`. The Habitat carries the resolved peer name as a concrete string; rails never see groups.
- **List fields (`acceptsWorkFrom:`, `messagesWith:`)** — group references expand to all current visible members at spawn time, with dynamic updates: the cohort tracker on the receiving peer updates the materialised list as `mesh-update` envelopes arrive.
- **Empty group at singular-field resolution time is a spawn error.** Spawn fails with: *"<peer>: <field> references empty group `<ref>` at spawn time."* The recipe author either declares a member in `initial_mesh:` first, ensures spawn order, or accepts the configuration is unspawnable.

### Visibility rule

X can see Y iff *any* of:
- X is the spawner of Y, **or**
- Y is the spawner of X, **or**
- X and Y share a spawner *and* share at least one group within that spawner's namespace.

Hosts have no special visibility privilege at the LLM tool surface — `peer_list` returns only direct children plus the host's own spawner edges (which is empty for the top peer). Tree-wide visibility is a launcher-socket affordance for the human via `/focus`, not an LLM tool surface property.

### Cohort registry shape

Hosted in the `mesh-mux` extension on the host peer:

```ts
type CohortRegistry = Map<spawnerName, Map<groupName, peerName[]>>;
```

The registry is the single source of truth. `mesh-update` envelopes broadcast deltas to peers in shared groups; `cohort-tracker` (folded into `peer-bus`) maintains per-peer caches; race window for unknown senders resolves via host lookup endpoint.

### `mesh-update` envelope

```ts
{
  kind: "mesh-update",
  spawner: string,           // namespace owner
  changes: [
    { peer: string, recipe: string, groups: string[], op: "add" | "remove" },
    ...
  ],
  ts: number,
}
```

Sent on the launcher socket from host to peers within the spawner's namespace who share at least one group with the affected peer. Recipients update their cohort cache accordingly.

### Validation

- A recipe is rejected at parse time if:
  - `submitsWorkTo:` or `escalatesTo:` is given a list value (singular fields are structurally singular).
  - A group reference uses a recipe name that doesn't appear anywhere reachable from the recipe's `spawns:` (otherwise the reference is unresolvable).
  - `groups:` on an `initial_mesh:` entry contains a name reserved for symbolics (`_default` is reserved for the implicit fallback; users may not name groups starting with `_` to keep that namespace open).

### Migration

- ADR-0005's launch-time `@<name>` group resolution disappears with the topology artifact (per ADR-0007). Recipes that use launch-time groups are migrated to spawner-scoped groups via inline declaration.
- `pi-sandbox/.pi/extensions/_lib/group-membership.mjs` and `ref-resolver.mjs` are repurposed: same logic, but the consumer is `mesh-mux`'s spawn-time resolver rather than `launch-mesh.mjs`'s topology validator.
- Existing meshes (`grouped-mesh.yaml`, `anon-grouped-mesh.yaml`) migrate cleanly: each becomes a host recipe with `initial_mesh:` carrying `groups:` per entry, and the host's `spawns:` block declares per-recipe wiring with `@$myGroups`-flavoured references.
