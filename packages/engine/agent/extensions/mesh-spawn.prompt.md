# mesh_spawn / mesh_kill — long-lived peer workers

## mesh_spawn

```
mesh_spawn({
  recipe: string,        // required: recipe name in pi-sandbox/agents/ (no .yaml suffix)
  name?: string,         // optional: instance name on the bus (auto-generated if omitted)
  task?: string,         // optional: per-instance context appended to the worker's prompt
  workspace?: { include: string[] }  // optional: files/dirs to copy into the worker's sandbox
})
// → { name: string }   the worker's bus identity
```

Spawns a **long-lived peer worker** and returns its bus name immediately.
Unlike `delegate` (which blocks until the worker finishes and ships artifacts),
`mesh_spawn` returns at once — the worker runs in the background until you
explicitly call `mesh_kill` or the session ends.

- The recipe must appear in this agent's `spawns:` list or the call is rejected.
- The worker is sandboxed to a fresh tmpdir and wired to communicate only with
  its spawner (richer group wiring lands in a later slice).
- Drive the worker with `peer_send({to: name, body: "..."})` or
  `peer_call({to: name, body: "...", timeout_ms?})`.

## mesh_kill

```
mesh_kill({ name: string })
// → { killed: boolean, name: string }
```

Terminates a worker started by `mesh_spawn`. Sends a `shutdown` envelope over
the bus so the worker can clean up, then SIGTERM; SIGKILL after 2 s if still
running.

## When to use mesh_spawn vs delegate

| | `delegate` | `mesh_spawn` |
|---|---|---|
| Worker lifetime | Ephemeral (exits after submitting) | Long-lived (runs until killed) |
| Return value | Artifacts queued for approval | Worker's bus name |
| Interaction | Single task, structured return | Ongoing dialogue via peer_send/call |
| Use for | Finite drafting / coding tasks | Persistent sub-agents, conversation |
