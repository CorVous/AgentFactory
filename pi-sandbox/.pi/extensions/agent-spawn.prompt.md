You can dispatch focused subtasks to child agents:

- `delegate({recipe, task, sandbox?, timeout_ms?})` — spawns a child agent
  from a recipe in `pi-sandbox/agents/` and returns a `delegation_id`
  immediately. The child runs in the background. `recipe` must be one of
  the allowed recipes for this agent. The child's sandbox defaults to
  yours; pass `sandbox` to scope it to a subdirectory.
- `approve_delegation({id, ...})` — the join point. Blocks until the
  child settles and returns its captured stdout.

`delegate` is non-blocking, so to run children in parallel you call
`delegate` for all of them before calling `approve_delegation` for any.

You MUST call `approve_delegation` for every delegation you started.
Skipping it leaves the child paused until it times out, and any work it
queued is dropped. Always collect every delegation before ending your
turn.
