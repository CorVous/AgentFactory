# Worked examples — composing recipes

Parent: [`docs/agents.md`](../agents.md). For the rails referenced here,
see [`rails-reference.md`](./rails-reference.md); for the mesh_spawn flow,
[`multi-agent.md`](./multi-agent.md).

## deferred-writer

`pi-sandbox/agents/deferred-writer.yaml` composes three extensions:

- `sandbox` (baseline) — disables `bash`, clamps fs activity to the root.
- `deferred-write` — registers the `deferred_write` tool. Drafts are
  buffered in extension memory; the extension registers a handler with
  the `deferred-confirm` baseline that previews queued drafts and writes
  approved ones (sha256-verified after write, ≤ 50 files / ≤ 2 MB each).
- `no-edit` — blocks `edit` outright and rejects any create-only tool
  whose target already exists. The create-only set is discovered at
  session start from `pi.getAllTools()`: any tool whose schema declares
  `path: string` plus a content-shaped string field
  (`content` | `text` | `body`). The static fallback covers `write` and
  `deferred_write`. Drop the extension entirely if you want an agent
  that can overwrite or edit existing files, or compose a custom
  extension if you need a different create-only tool set.

Non-interactive runs refuse to write because there's no UI to confirm.

`deferred-write` and `no-edit` are independent rails: an agent that wants
overwrite-on-approval keeps `deferred-write` and omits `no-edit`; an
agent using plain `write` but still wanting create-only semantics keeps
`no-edit` and omits `deferred-write`.

## deferred-author (composing all four kinds)

`pi-sandbox/agents/deferred-author.yaml` composes the full set of
deferred-* tool extensions and relies on `deferred-confirm` (baseline)
to show one approval dialog at end-of-turn:

- `deferred-write` — `deferred_write({path, content})`. Creates new
  files. Same shape and limits as the worked example above.
- `deferred-edit` — `deferred_edit({path, old_string, new_string})`.
  Modifies existing files. Validates `old_string` is unique against the
  buffered file state at queue time, so multi-edit ordering works. Re-
  validates against disk at apply time; any drift aborts the batch.
- `deferred-move` — `deferred_move({src, dst})`. Verbatim relocation:
  bit-identical content at the new path. Refuses to overwrite (`dst`
  must not exist). Parent directories of `dst` are auto-created at
  apply time. Cross-device EXDEV falls back to copy + unlink.
- `deferred-delete` — `deferred_delete({path})`. Removes existing files
  (rejects directories and missing paths at queue time so the model
  gets immediate feedback).

End-of-turn approval is **all-or-nothing across all four kinds**: the
`deferred-confirm` coordinator collects every handler's `prepare`
result, aborts the whole batch if any returns `status: "error"`,
otherwise renders one `ctx.ui.confirm` with sections per handler. On
approve, the apply phase runs in fixed priority order (writes → edits
→ moves → deletes) so compositions like "edit `foo.ts`, then move it
to `lib/foo.ts`" land deterministically — the edit hits the original
path, then the rename moves the now-edited file. The reverse ("move
then edit at the new path") fails at the edit's re-validation because
`dst` doesn't exist when the edit's `prepare` reads from disk.

Authoring agents should compose the four deferred-* extensions and let
`deferred-confirm` drive the dialog rather than each running its own.
`no-edit` is redundant under this composition: the recipe's `tools:`
allowlist already omits the built-in `edit`/`write`, and each
deferred-* tool enforces its own existence/non-existence preconditions
at queue time.

## writer-foreman (mesh_spawn)

`pi-sandbox/agents/writer-foreman.yaml` is a Lead-tier foreman that
decomposes a drafting request and dispatches focused batches to
`deferred-writer` workers. The recipe declares:

```yaml
spawns: [deferred-writer]
tools: [read, ls, grep, find, mesh_spawn, mesh_kill, peer_send, peer_call, peer_inbox, respond_to_request]
```

Flow per task:

1. Foreman calls `mesh_spawn({recipe: "deferred-writer", task: "…"})`.
   The call spawns a long-lived worker with the given task and returns
   immediately with the worker's name.
2. `mesh-spawn` allocates a fresh tmpdir scratch root, constructs a
   habitat overlay (`escalatesTo = submitsWorkTo = acceptsWorkFrom = [foreman]`,
   which map to `Habitat.supervisor`, `Habitat.submitsWorkTo`, `Habitat.acceptsWorkFrom`),
   and spawns the worker via `pi --recipe deferred-writer` (using
   `buildRecipeChildArgv` from `packages/engine/agent/lib/child-spawn.mjs`).
   The worker's name is registered in the `__pi_mesh_spawn_nodes__` registry.
3. The worker runs, drafts files into its in-memory `deferred-write`
   queue, hits `agent_end`. Because `submitsWorkTo` is set, `deferred-confirm`
   ships a `submission` envelope to the foreman over the bus and waits
   for a reply.
4. The foreman's supervisor rail receives the submission. The
   `__pi_mesh_spawn_is_my_worker__` predicate (set by `mesh-spawn`) admits
   the worker's envelope before the static `acceptsWorkFrom` check, so
   dynamically-spawned names don't need to be pre-listed.
5. The supervisor rail queues the submission and prompts the foreman's
   model. Multiple submissions arriving in the same turn are batched
   into one composite prompt (N-of-M style), so the foreman reviews all
   pending work together in one `respond_to_request` call per item.
6. The foreman calls `respond_to_request` to approve, reject, or revise.
   On approval, artifacts are applied to the canonical filesystem and the
   worker receives `approval-result(approved:true)` — the worker exits
   cleanly. The foreman can then call `mesh_kill` to clean up.

A foreman that is itself a worker in a larger mesh submits its own
artifacts to its supervisor; the recursive shape works at every tier.
