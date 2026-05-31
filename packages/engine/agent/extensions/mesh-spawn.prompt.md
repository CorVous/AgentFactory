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
The worker runs in the background until you explicitly call `mesh_kill` or
the session ends.

- The recipe must appear in this agent's `spawns:` list or the call is rejected.
- The worker is sandboxed to a fresh tmpdir and wired to communicate with its spawner.
- Drive the worker with `peer_send({to: name, body: "..."})` or
  `peer_call({to: name, body: "...", timeout_ms?})`.
- When the worker submits work via a `submission` envelope, it surfaces as a
  `respond_to_request` prompt. Multiple submissions in one turn are batched
  into one composite prompt with a numbered section per worker.

## mesh_kill

```
mesh_kill({ name: string })
// → { killed: boolean, name: string }
```

Terminates a worker started by `mesh_spawn`. Sends a `shutdown` envelope over
the bus so the worker can clean up, then SIGTERM; SIGKILL after 2 s if still
running.

## Typical spawn → drive → submission → kill lifecycle

1. `mesh_spawn({recipe, task})` — starts the worker, returns its name
2. Optionally `peer_send`/`peer_call` the worker for further instructions
3. Worker drafts work and ships a `submission` envelope
4. `respond_to_request({msg_id, action: "approve"|"reject"|"revise", note?})` — review the work
5. `mesh_kill({name})` — terminate the worker once settled
